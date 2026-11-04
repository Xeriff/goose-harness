import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { OrchestrationV2StoredEvent } from "@t3tools/contracts";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as GooseExtensionHost from "./GooseExtensionHost.ts";

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "goose-host-test-" });
const layerBase = Layer.mergeAll(
  layerConfig,
  ServerSecretStore.layer.pipe(Layer.provide(layerConfig)),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

/** A plugin folder with a package.json and an optional server module. */
const writePlugin = Effect.fn("test.writePlugin")(function* (
  root: string,
  folder: string,
  goose: Record<string, unknown> | undefined,
  serverSource?: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(root, folder);
  yield* fileSystem.makeDirectory(dir, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(dir, "package.json"),
    JSON.stringify({ name: folder, version: "1.2.3", ...(goose ? { goose } : {}) }),
  );
  if (serverSource !== undefined) {
    yield* fileSystem.writeFileString(path.join(dir, "server.mjs"), serverSource);
  }
});

const manifest = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  displayName: id,
  apiVersion: 1,
  server: "./server.mjs",
  enabledByDefault: true,
  ...extra,
});

const makeHost = Effect.fn("test.makeHost")(function* (
  root: string,
  events: Queue.Queue<OrchestrationV2StoredEvent> | undefined = undefined,
) {
  const eventQueue = events ?? (yield* Queue.unbounded<OrchestrationV2StoredEvent>());
  const sink = {
    stream: () => Stream.fromQueue(eventQueue),
    latestSequence: () => Effect.succeed(0),
  } as unknown as EventSink.EventSinkV2["Service"];
  return yield* GooseExtensionHost.make([{ dir: root, source: "user" }]).pipe(
    Effect.provideService(EventSink.EventSinkV2, sink),
  );
});

const tempRoot = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "goose-plugins-" });
});

const request = (method: "GET" | "POST", path: string, body?: unknown) => ({
  method,
  path,
  query: new URLSearchParams(),
  headers: {},
  body,
});

it.layer(layerBase)("GooseExtensionHost", (it) => {
  it.effect("activates enabled plugins and serves their routes and tools", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      yield* writePlugin(
        root,
        "board",
        manifest("board"),
        `export default {
          activate(ctx) {
            ctx.http.route("POST", "/echo", (req) => ({ status: 201, body: { got: req.body } }));
            ctx.mcp.registerTool({
              name: "view",
              description: "Shows the board.",
              inputSchema: { type: "object" },
              readOnly: true,
              handler: async (args, call) => {
                await ctx.storage.set("last", call.threadId);
                return { text: "board for " + call.threadId + " " + JSON.stringify(args) };
              },
            });
          },
        };`,
      );

      const host = yield* makeHost(root);
      const { plugins } = yield* host.list;
      assert.deepStrictEqual(
        plugins.map(({ id, state, tools, version }) => ({ id, state, tools, version })),
        [{ id: "board", state: "active", tools: ["board_view"], version: "1.2.3" }],
      );

      const response = yield* host.handleRequest("board", request("POST", "/echo", { a: 1 }));
      assert.deepStrictEqual(response, Option.some({ status: 201, body: { got: { a: 1 } } }));
      assert.deepStrictEqual(
        yield* host.handleRequest("board", request("GET", "/echo")),
        Option.none(),
      );

      const [tool] = yield* host.tools;
      assert.isDefined(tool);
      const result = yield* host.callTool(tool!, { x: 1 }, "thread-1");
      assert.deepStrictEqual(result, { text: 'board for thread-1 {"x":1}', isError: false });
    }),
  );

  it.effect("keeps other plugins running when one fails to activate", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      yield* writePlugin(
        root,
        "a-broken",
        manifest("broken"),
        `export default { activate() { throw new Error("boom"); } };`,
      );
      yield* writePlugin(root, "b-no-export", manifest("no-export"), `export const x = 1;`);
      yield* writePlugin(
        root,
        "c-fine",
        manifest("fine"),
        `export default { activate(ctx) { ctx.http.route("GET", "/", () => ({ body: "ok" })); } };`,
      );

      const host = yield* makeHost(root);
      const { plugins } = yield* host.list;
      assert.deepStrictEqual(
        plugins.map(({ id, state, error }) => ({ id, state, error })),
        [
          { id: "broken", state: "failed", error: "boom" },
          {
            id: "no-export",
            state: "failed",
            error: "The server entry's default export has no activate().",
          },
          { id: "fine", state: "active", error: null },
        ],
      );
      assert.deepStrictEqual(
        yield* host.handleRequest("fine", request("GET", "/")),
        Option.some({ body: "ok" }),
      );
    }),
  );

  it.effect("marks a plugin whose activate never finishes as failed after the timeout", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      yield* writePlugin(
        root,
        "hang",
        manifest("hang"),
        `export default { activate() { globalThis.gooseTestActivated(); return new Promise(() => {}); } };`,
      );
      const activated = Promise.withResolvers<void>();
      Object.assign(globalThis, { gooseTestActivated: () => activated.resolve() });

      const fiber = yield* makeHost(root).pipe(Effect.forkChild);
      // The activation timer starts with activate(); advance the clock only once it is running.
      yield* Effect.promise(() => activated.promise);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      const host = yield* Fiber.join(fiber);
      const [status] = (yield* host.list).plugins;
      assert.strictEqual(status?.state, "failed");
      assert.strictEqual(status?.error, "Timed out after 10 seconds.");
    }),
  );

  it.effect("skips disabled plugins and reports invalid manifests", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      yield* writePlugin(
        root,
        "off",
        manifest("off", { enabledByDefault: false }),
        `export default { activate() { throw new Error("must not run"); } };`,
      );
      yield* writePlugin(root, "bad-id", { id: "Bad Id", displayName: "x", apiVersion: 1 });
      yield* writePlugin(root, "future", manifest("future", { apiVersion: 2 }));
      yield* writePlugin(root, "escape", manifest("escape", { server: "../outside.mjs" }));
      yield* writePlugin(root, "plain", undefined);

      const host = yield* makeHost(root);
      const { plugins, problems } = yield* host.list;
      assert.deepStrictEqual(
        plugins.map(({ id, state, enabled }) => ({ id, state, enabled })),
        [{ id: "off", state: "disabled", enabled: false }],
      );
      assert.deepStrictEqual(
        problems.map((problem) => problem.reason),
        [
          "The goose manifest needs an id (lowercase letters, digits, dashes), displayName and apiVersion.",
          "Plugin escape's server entry is outside its folder.",
          "Plugin future targets plugin API 2; this host supports 1.",
        ],
      );
    }),
  );

  it.effect("persists enable choices and says when a restart is needed", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      yield* writePlugin(root, "toggle", manifest("toggle"), `export default { activate() {} };`);

      const host = yield* makeHost(root);
      assert.deepStrictEqual(yield* host.setEnabled("toggle", false), { restartRequired: true });
      assert.deepStrictEqual(yield* host.setEnabled("toggle", true), { restartRequired: false });
      yield* host.setEnabled("toggle", false);
      const missing = yield* host.setEnabled("nope", true).pipe(Effect.flip);
      assert.strictEqual(missing._tag, "GoosePluginNotFoundError");

      const restarted = yield* makeHost(root);
      const [status] = (yield* restarted.list).plugins;
      assert.deepStrictEqual(
        { enabled: status?.enabled, state: status?.state },
        { enabled: false, state: "disabled" },
      );
    }),
  );

  it.effect("turns a throwing tool into an error result instead of failing the call", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      yield* writePlugin(
        root,
        "tools",
        manifest("tools"),
        `export default { activate(ctx) {
          ctx.mcp.registerTool({
            name: "explode",
            description: "Fails.",
            inputSchema: { type: "object" },
            handler: () => { throw new Error("no board"); },
          });
        } };`,
      );

      const host = yield* makeHost(root);
      const [tool] = yield* host.tools;
      const result = yield* host.callTool(tool!, {}, "thread-1");
      assert.deepStrictEqual(result, {
        text: "The tools_explode tool failed: no board",
        isError: true,
      });
    }),
  );

  it.effect("delivers matching events and survives a throwing handler", () =>
    Effect.gen(function* () {
      const root = yield* tempRoot;
      const seen: Array<string> = [];
      const done = Promise.withResolvers<void>();
      // The plugin module reports through this global; the test awaits it instead of polling.
      Object.assign(globalThis, {
        gooseTestSeen: (line: string) => {
          seen.push(line);
          if (seen.length === 2) done.resolve();
        },
      });
      yield* writePlugin(
        root,
        "a-thrower",
        manifest("thrower"),
        `export default { activate(ctx) { ctx.events.on("*", () => { throw new Error("bad hook"); }); } };`,
      );
      yield* writePlugin(
        root,
        "b-watcher",
        manifest("watcher"),
        `export default { activate(ctx) {
          ctx.events.on(["run.created"], (event) => {
            globalThis.gooseTestSeen(event.type + ":" + event.threadId + ":" + event.sequence + ":" + event.occurredAt);
          });
        } };`,
      );

      const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
      yield* makeHost(root, events);
      const event = (sequence: number, type: string) =>
        ({
          sequence,
          commandId: null,
          event: {
            id: `event-${sequence}`,
            threadId: "thread-7",
            occurredAt: DateTime.makeUnsafe("2026-11-04T00:00:00Z"),
            type,
            payload: {},
          },
        }) as unknown as OrchestrationV2StoredEvent;
      yield* Queue.offerAll(events, [
        event(1, "message"),
        event(2, "run.created"),
        event(3, "run.created"),
      ]);

      yield* Effect.promise(() => done.promise);
      assert.deepStrictEqual(seen, [
        "run.created:thread-7:2:2026-11-04T00:00:00.000Z",
        "run.created:thread-7:3:2026-11-04T00:00:00.000Z",
      ]);
    }),
  );
});
