import * as NodeAssert from "node:assert/strict";

import type {
  GooseHttpResponse,
  GooseServerPluginContext,
  GooseToolDefinition,
  JsonValue,
} from "@t3tools/goose-plugin-api";
import { it } from "vite-plus/test";

import plugin from "./server.ts";

/** A stand-in host: what activate registered, and an in-memory store. */
async function activate() {
  const values = new Map<string, JsonValue>();
  const store = {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: JsonValue) => void values.set(key, value),
    delete: async (key: string) => void values.delete(key),
    keys: async () => [...values.keys()],
  };
  const routes = new Map<string, () => Promise<GooseHttpResponse> | GooseHttpResponse>();
  const tools: Array<GooseToolDefinition> = [];
  const ctx: GooseServerPluginContext = {
    pluginId: "example",
    pluginDir: "",
    dataDir: "",
    log: { info() {}, warn() {}, error() {} },
    settings: store,
    storage: store,
    secrets: { get: async () => undefined, async set() {}, async delete() {} },
    http: {
      route: (method, path, handler) =>
        void routes.set(`${method} ${path}`, () =>
          handler({ method, path, query: new URLSearchParams(), headers: {}, body: undefined }),
        ),
    },
    events: { on() {} },
    mcp: {
      registerTool: (tool) => void tools.push(tool),
      servers: async () => [],
      listTools: async () => [],
      callTool: async () => ({ isError: true, content: [] }),
    },
  };
  await plugin.activate(ctx);
  return { routes, tools };
}

it("counts clicks and lets agents read the count", async () => {
  const { routes, tools } = await activate();
  NodeAssert.deepEqual((await routes.get("GET /clicks")!()).body, { clicks: 0 });
  await routes.get("POST /clicks")!();
  NodeAssert.deepEqual((await routes.get("POST /clicks")!()).body, { clicks: 2 });
  NodeAssert.deepEqual(await tools[0]!.handler({}, { threadId: "t" }), { text: "2" });
});
