import * as NodeURL from "node:url";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type {
  GooseAgentEvent,
  GooseHttpMethod,
  GooseHttpRequest,
  GooseHttpResponse,
  GooseServerPlugin,
  GooseServerPluginContext,
  GooseToolDefinition,
  JsonValue,
} from "@t3tools/goose-plugin-api";

import type { OrchestrationV2StoredEvent } from "@t3tools/contracts";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as GooseSharedMcp from "./GooseSharedMcp.ts";
import {
  type DiscoveredPlugin,
  type DiscoveryProblem,
  discoverPlugins,
} from "./GoosePluginDiscovery.ts";

const ACTIVATE_TIMEOUT = "10 seconds";
const EVENT_HANDLER_TIMEOUT = "5 seconds";
const REQUEST_HANDLER_TIMEOUT = "30 seconds";
const SECRET_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;
const STORE_KEY = /^[^\0]{1,200}$/;

export class GoosePluginCallError extends Schema.TaggedError<GoosePluginCallError>()(
  "GoosePluginCallError",
  {
    pluginId: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} failed during ${this.operation}.`;
  }
}

export class GoosePluginNotFoundError extends Schema.TaggedError<GoosePluginNotFoundError>()(
  "GoosePluginNotFoundError",
  { pluginId: Schema.String },
) {
  override get message(): string {
    return `No plugin ${this.pluginId} is installed.`;
  }
}

export type GoosePluginState = "active" | "disabled" | "failed";

export interface GoosePluginStatus {
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly version: string;
  readonly source: DiscoveredPlugin["source"];
  readonly enabled: boolean;
  readonly state: GoosePluginState;
  readonly error: string | null;
  readonly tools: ReadonlyArray<string>;
  readonly hasWeb: boolean;
}

export interface GooseRegisteredTool {
  readonly pluginId: string;
  /** Name advertised to agents. */
  readonly name: string;
  readonly definition: GooseToolDefinition;
}

interface PluginRoute {
  readonly method: GooseHttpMethod;
  readonly path: string;
  readonly handler: (request: GooseHttpRequest) => Promise<GooseHttpResponse> | GooseHttpResponse;
}

interface EventSubscription {
  readonly pluginId: string;
  readonly types: ReadonlySet<string> | "*";
  readonly handler: (event: GooseAgentEvent) => Promise<void> | void;
}

const HostStateSchema = Schema.Struct({
  enabled: Schema.Record(Schema.String, Schema.Boolean),
});
type HostState = typeof HostStateSchema.Type;
const decodeHostState = Schema.decodeUnknownEffect(Schema.fromJsonString(HostStateSchema));
const decodeJsonRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

export class GooseExtensionHost extends Context.Service<
  GooseExtensionHost,
  {
    readonly list: Effect.Effect<{
      readonly plugins: ReadonlyArray<GoosePluginStatus>;
      readonly problems: ReadonlyArray<DiscoveryProblem>;
    }>;
    /** Persists the choice; it applies the next time the server starts. */
    readonly setEnabled: (
      pluginId: string,
      enabled: boolean,
    ) => Effect.Effect<{ readonly restartRequired: boolean }, GoosePluginNotFoundError>;
    readonly tools: Effect.Effect<ReadonlyArray<GooseRegisteredTool>>;
    readonly callTool: (
      tool: GooseRegisteredTool,
      args: Record<string, unknown>,
      threadId: string,
    ) => Effect.Effect<{ readonly text: string; readonly isError: boolean }>;
    /** `None` when no active plugin has a route for this method and path. */
    readonly handleRequest: (
      pluginId: string,
      request: GooseHttpRequest,
    ) => Effect.Effect<Option.Option<GooseHttpResponse>, GoosePluginCallError>;
  }
>()("t3/goose/GooseExtensionHost") {}

/** Where plugins are discovered: the repo's `plugins/`, the T3 home's `goose/plugins`, and `GOOSE_PLUGIN_DIRS`. */
const pluginRoots = Effect.fn("GooseExtensionHost.pluginRoots")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const repoPlugins = path.resolve(
    NodeURL.fileURLToPath(new URL(".", import.meta.url)),
    "../../../../plugins",
  );
  const extra = (process.env.GOOSE_PLUGIN_DIRS ?? "")
    .split((yield* HostProcess.Platform) === "win32" ? ";" : ":")
    .filter((dir) => dir.length > 0)
    .map((dir) => ({ dir: path.resolve(dir), source: "user" as const }));
  return [
    { dir: repoPlugins, source: "repo" as const },
    { dir: path.join(config.baseDir, "goose", "plugins"), source: "user" as const },
    ...extra,
  ];
});

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "Unknown error";

export const make = Effect.fn("GooseExtensionHost.make")(function* (
  roots: ReadonlyArray<{ readonly dir: string; readonly source: DiscoveredPlugin["source"] }>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const eventSink = yield* EventSink.EventSinkV2;
  const sharedMcp = yield* GooseSharedMcp.make;
  const services = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(services);
  const runPromise = Effect.runPromiseWith(services);

  const gooseDir = path.join(config.stateDir, "goose");
  const statePath = path.join(gooseDir, "state.json");
  yield* fileSystem.makeDirectory(gooseDir, { recursive: true }).pipe(Effect.orDie);
  const writeLock = yield* Semaphore.make(1);

  const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
  const writeJsonAtomic = Effect.fn("GooseExtensionHost.writeJsonAtomic")(function* (
    file: string,
    value: unknown,
  ) {
    const temp = `${file}.${process.pid}.tmp`;
    const write = Effect.gen(function* () {
      yield* fileSystem.writeFileString(temp, yield* encodeJson(value));
      yield* fileSystem.rename(temp, file);
    });
    yield* writeLock.withPermits(1)(write).pipe(Effect.orDie);
  });

  const hostState: HostState = yield* fileSystem.readFileString(statePath).pipe(
    Effect.flatMap(decodeHostState),
    Effect.orElseSucceed(() => ({ enabled: {} })),
  );
  const enabled = new Map(Object.entries(hostState.enabled));

  const discovery = yield* discoverPlugins(roots);
  const statuses = new Map<string, GoosePluginStatus>();
  const routes = new Map<string, Array<PluginRoute>>();
  const tools: Array<GooseRegisteredTool> = [];
  const subscriptions: Array<EventSubscription> = [];
  const deactivators: Array<{
    readonly pluginId: string;
    readonly run: () => Promise<void> | void;
  }> = [];

  const makeStore = (file: string) => {
    let cache: Record<string, JsonValue> | undefined;
    const load = Effect.gen(function* () {
      if (cache !== undefined) return cache;
      cache = yield* fileSystem.readFileString(file).pipe(
        Effect.flatMap(decodeJsonRecord),
        Effect.map((record) => ({ ...record }) as Record<string, JsonValue>),
        Effect.orElseSucceed((): Record<string, JsonValue> => ({})),
      );
      return cache;
    });
    const checkKey = (key: string) => {
      if (!STORE_KEY.test(key)) throw new TypeError(`Invalid key: ${JSON.stringify(key)}`);
    };
    return {
      get: (key: string) => runPromise(load.pipe(Effect.map((record) => record[key]))),
      set: (key: string, value: JsonValue) => {
        checkKey(key);
        return runPromise(
          load.pipe(
            Effect.flatMap((record) => {
              record[key] = structuredClone(value);
              return writeJsonAtomic(file, record);
            }),
          ),
        );
      },
      delete: (key: string) =>
        runPromise(
          load.pipe(
            Effect.flatMap((record) => {
              if (!(key in record)) return Effect.void;
              delete record[key];
              return writeJsonAtomic(file, record);
            }),
          ),
        ),
      keys: () => runPromise(load.pipe(Effect.map((record) => Object.keys(record)))),
    };
  };

  const callPlugin = <A>(
    pluginId: string,
    operation: string,
    timeout: string,
    run: () => A | Promise<A>,
  ) =>
    Effect.tryPromise({
      try: async () => await run(),
      catch: (cause) => new GoosePluginCallError({ pluginId, operation, cause }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeout as "5 seconds",
        orElse: () =>
          Effect.fail(
            new GoosePluginCallError({
              pluginId,
              operation,
              cause: new Error(`Timed out after ${timeout}.`),
            }),
          ),
      }),
    );

  const activatePlugin = Effect.fn("GooseExtensionHost.activatePlugin")(function* (
    plugin: DiscoveredPlugin,
  ) {
    const { id } = plugin.manifest;
    const dataDir = path.join(gooseDir, "plugins", id);
    yield* fileSystem.makeDirectory(dataDir, { recursive: true }).pipe(Effect.orDie);

    const pluginRoutes: Array<PluginRoute> = [];
    const pluginTools: Array<GooseRegisteredTool> = [];
    const pluginSubscriptions: Array<EventSubscription> = [];
    let registering = true;
    const assertRegistering = (what: string) => {
      if (!registering) throw new Error(`${what} must be registered during activate().`);
    };
    const logFields = (fields?: Record<string, unknown>) => ({ plugin: id, ...fields });
    const secretName = (name: string) => {
      if (!SECRET_NAME.test(name))
        throw new TypeError(`Invalid secret name: ${JSON.stringify(name)}`);
      return `goose-${id}-${name}`;
    };

    const context: GooseServerPluginContext = {
      pluginId: id,
      pluginDir: plugin.dir,
      dataDir,
      log: {
        info: (message, fields) => void runFork(Effect.logInfo(message, logFields(fields))),
        warn: (message, fields) => void runFork(Effect.logWarning(message, logFields(fields))),
        error: (message, fields) => void runFork(Effect.logError(message, logFields(fields))),
      },
      settings: makeStore(path.join(dataDir, "settings.json")),
      storage: makeStore(path.join(dataDir, "storage.json")),
      secrets: {
        get: (name) =>
          runPromise(
            secretStore
              .get(secretName(name))
              .pipe(
                Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
                Effect.map(Option.getOrUndefined),
              ),
          ),
        set: (name, value) =>
          runPromise(secretStore.set(secretName(name), new TextEncoder().encode(value))),
        delete: (name) => runPromise(secretStore.remove(secretName(name))),
      },
      http: {
        route: (method, routePath, handler) => {
          assertRegistering("Routes");
          if (!routePath.startsWith("/")) throw new TypeError("Route paths start with /.");
          pluginRoutes.push({ method, path: routePath, handler });
        },
      },
      events: {
        on: (type, handler) => {
          assertRegistering("Event handlers");
          pluginSubscriptions.push({
            pluginId: id,
            types: type === "*" ? "*" : new Set(typeof type === "string" ? [type] : type),
            handler,
          });
        },
      },
      mcp: {
        registerTool: (definition) => {
          assertRegistering("Tools");
          if (!TOOL_NAME.test(definition.name)) {
            throw new TypeError(`Invalid tool name: ${JSON.stringify(definition.name)}`);
          }
          pluginTools.push({
            pluginId: id,
            name: `${id.replaceAll("-", "_")}_${definition.name}`,
            definition,
          });
        },
        servers: () => runPromise(sharedMcp.servers()),
        listTools: (server) => runPromise(sharedMcp.listTools(server)),
        callTool: (server, tool, args = {}) => runPromise(sharedMcp.callTool(server, tool, args)),
      },
    };

    const result = yield* Effect.gen(function* () {
      const module = yield* callPlugin(
        id,
        "load",
        ACTIVATE_TIMEOUT,
        () => import(NodeURL.pathToFileURL(plugin.serverEntry as string).href),
      );
      const instance = (module as { default?: GooseServerPlugin }).default;
      if (typeof instance?.activate !== "function") {
        return yield* new GoosePluginCallError({
          pluginId: id,
          operation: "load",
          cause: new Error("The server entry's default export has no activate()."),
        });
      }
      yield* callPlugin(id, "activate", ACTIVATE_TIMEOUT, () => instance.activate(context));
      return instance;
    }).pipe(Effect.result);
    registering = false;

    if (result._tag === "Failure") {
      const error = describeCause(result.failure.cause);
      yield* Effect.logError("Goose plugin failed to activate", { plugin: id, error });
      return { state: "failed" as const, error, tools: [] };
    }

    routes.set(id, pluginRoutes);
    tools.push(...pluginTools);
    subscriptions.push(...pluginSubscriptions);
    const deactivate = result.success.deactivate;
    if (deactivate) deactivators.push({ pluginId: id, run: deactivate });
    yield* Effect.logInfo("Goose plugin active", {
      plugin: id,
      routes: pluginRoutes.length,
      tools: pluginTools.length,
      hooks: pluginSubscriptions.length,
    });
    return { state: "active" as const, error: null, tools: pluginTools.map((tool) => tool.name) };
  });

  for (const plugin of discovery.plugins) {
    const { manifest } = plugin;
    const isEnabled = enabled.get(manifest.id) ?? manifest.enabledByDefault === true;
    const outcome =
      isEnabled && plugin.serverEntry !== undefined
        ? yield* activatePlugin(plugin)
        : {
            state: isEnabled ? ("active" as const) : ("disabled" as const),
            error: null,
            tools: [],
          };
    statuses.set(manifest.id, {
      id: manifest.id,
      displayName: manifest.displayName,
      description: manifest.description ?? null,
      version: plugin.version,
      source: plugin.source,
      enabled: isEnabled,
      state: outcome.state,
      error: outcome.error,
      tools: outcome.tools,
      hasWeb: manifest.web !== undefined,
    });
  }
  for (const problem of discovery.problems) {
    yield* Effect.logWarning("Goose plugin skipped", { dir: problem.dir, reason: problem.reason });
  }

  if (subscriptions.length > 0) {
    const toAgentEvent = (stored: OrchestrationV2StoredEvent): GooseAgentEvent => ({
      sequence: stored.sequence,
      type: stored.event.type,
      threadId: stored.event.threadId,
      ...(stored.event.runId === undefined ? {} : { runId: stored.event.runId }),
      occurredAt: DateTime.formatIso(stored.event.occurredAt),
      payload: "payload" in stored.event ? stored.event.payload : undefined,
    });
    // Each handler gets its own timeout and error boundary: a failing plugin is logged, never fatal.
    // Only events from now on: replaying retained history would re-run plugin side effects.
    const fromSequence = yield* eventSink.latestSequence().pipe(Effect.orElseSucceed(() => 0));
    yield* eventSink.stream({ afterSequence: fromSequence }).pipe(
      Stream.runForEach((stored) =>
        Effect.forEach(
          subscriptions.filter(
            (subscription) =>
              subscription.types === "*" || subscription.types.has(stored.event.type),
          ),
          (subscription) =>
            callPlugin(
              subscription.pluginId,
              `event ${stored.event.type}`,
              EVENT_HANDLER_TIMEOUT,
              () => subscription.handler(toAgentEvent(stored)),
            ).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Goose plugin event handler failed", {
                  plugin: error.pluginId,
                  operation: error.operation,
                  error: describeCause(error.cause),
                }),
              ),
            ),
          { discard: true },
        ),
      ),
      Effect.catch((error) => Effect.logError("Goose event stream stopped", { error })),
      Effect.forkScoped,
    );
  }

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      deactivators,
      ({ pluginId, run }) =>
        callPlugin(pluginId, "deactivate", ACTIVATE_TIMEOUT, run).pipe(Effect.ignore),
      { discard: true },
    ),
  );

  const list: GooseExtensionHost["Service"]["list"] = Effect.sync(() => ({
    plugins: [...statuses.values()],
    problems: discovery.problems,
  }));

  const setEnabled = Effect.fn("GooseExtensionHost.setEnabled")(function* (
    pluginId: string,
    value: boolean,
  ) {
    const status = statuses.get(pluginId);
    if (!status) return yield* new GoosePluginNotFoundError({ pluginId });
    enabled.set(pluginId, value);
    yield* writeJsonAtomic(statePath, { enabled: Object.fromEntries(enabled) });
    statuses.set(pluginId, { ...status, enabled: value });
    const running = status.state === "active";
    return { restartRequired: running !== value };
  });

  const callTool = Effect.fn("GooseExtensionHost.callTool")(function* (
    tool: GooseRegisteredTool,
    args: Record<string, unknown>,
    threadId: string,
  ) {
    return yield* callPlugin(tool.pluginId, `tool ${tool.name}`, REQUEST_HANDLER_TIMEOUT, () =>
      tool.definition.handler(args, { threadId }),
    ).pipe(
      Effect.map((result) => ({ text: result.text, isError: result.isError === true })),
      Effect.catch((error) =>
        Effect.logWarning("Goose plugin tool failed", {
          plugin: error.pluginId,
          tool: tool.name,
          error: describeCause(error.cause),
        }).pipe(
          Effect.as({
            text: `The ${tool.name} tool failed: ${describeCause(error.cause)}`,
            isError: true,
          }),
        ),
      ),
    );
  });

  const handleRequest = Effect.fn("GooseExtensionHost.handleRequest")(function* (
    pluginId: string,
    request: GooseHttpRequest,
  ) {
    const route = routes
      .get(pluginId)
      ?.find((candidate) => candidate.method === request.method && candidate.path === request.path);
    if (!route) return Option.none<GooseHttpResponse>();
    const response = yield* callPlugin(
      pluginId,
      `${request.method} ${request.path}`,
      REQUEST_HANDLER_TIMEOUT,
      () => route.handler(request),
    );
    return Option.some(response);
  });

  return GooseExtensionHost.of({
    list,
    setEnabled,
    tools: Effect.succeed(tools),
    callTool,
    handleRequest,
  });
});

export const layer = Layer.effect(
  GooseExtensionHost,
  Effect.flatMap(pluginRoots(), (roots) => make(roots)),
).pipe(
  // The same event sink instance orchestration commits to, by layer memoization.
  Layer.provide(RuntimeLayer.layerEventSink),
);
