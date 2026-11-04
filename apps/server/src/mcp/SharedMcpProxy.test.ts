// A fake upstream MCP server and OAuth provider on a local port.
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeHttp from "node:http";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import type { SharedMcpServer } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SharedMcpProxy from "./SharedMcpProxy.ts";

const layerMemorySecretStore = Layer.sync(ServerSecretStore.ServerSecretStore, () => {
  const stored = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromNullishOr(stored.get(name))),
    set: (name, value) => Effect.sync(() => void stored.set(name, value)),
    create: (name, value) => Effect.sync(() => void stored.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void stored.delete(name)),
  });
});

const layer = SharedMcpProxy.layer.pipe(
  Layer.provide(Layer.mergeAll(layerMemorySecretStore, NodeCrypto.layer)),
);

type Fake = { readonly base: string; readonly tokenRequests: Array<URLSearchParams> };

/**
 * An MCP server whose `/mcp` answers `initialize`, `tools/list` and
 * `tools/call` once `authorized(request)` holds. With `oauth`, it also serves
 * the discovery documents, client registration, and a token endpoint that
 * trades `the-code` for `good-token`.
 */
const fakeUpstream = (options: {
  readonly oauth: boolean;
  readonly authorized: (request: NodeHttp.IncomingMessage) => boolean;
}) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ readonly server: NodeHttp.Server; readonly fake: Fake }>((resolve) => {
          const tokenRequests: Array<URLSearchParams> = [];
          const fake: Fake = { base: "", tokenRequests };
          const json = (response: NodeHttp.ServerResponse, status: number, body: unknown) => {
            response.writeHead(status, { "content-type": "application/json" });
            response.end(JSON.stringify(body));
          };
          const server = NodeHttp.createServer((request, response) => {
            let body = "";
            request.on("data", (chunk) => (body += chunk));
            request.on("end", () => {
              const path = new URL(request.url ?? "/", fake.base).pathname;
              if (options.oauth && path === "/.well-known/oauth-protected-resource/mcp") {
                return json(response, 200, {
                  resource: `${fake.base}/mcp`,
                  authorization_servers: [fake.base],
                });
              }
              if (options.oauth && path === "/.well-known/oauth-authorization-server") {
                return json(response, 200, {
                  issuer: fake.base,
                  authorization_endpoint: `${fake.base}/authorize`,
                  token_endpoint: `${fake.base}/token`,
                  registration_endpoint: `${fake.base}/register`,
                  response_types_supported: ["code"],
                  code_challenge_methods_supported: ["S256"],
                });
              }
              if (options.oauth && path === "/register") {
                return json(response, 201, { ...JSON.parse(body), client_id: "client-1" });
              }
              if (options.oauth && path === "/token") {
                const form = new URLSearchParams(body);
                tokenRequests.push(form);
                return form.get("code") === "the-code"
                  ? json(response, 200, { access_token: "good-token", token_type: "Bearer" })
                  : json(response, 400, { error: "invalid_grant" });
              }
              if (path !== "/mcp") return json(response, 404, {});
              if (request.method !== "POST") {
                response.writeHead(405);
                return response.end();
              }
              if (!options.authorized(request)) {
                response.writeHead(
                  401,
                  options.oauth
                    ? {
                        "www-authenticate": `Bearer resource_metadata="${fake.base}/.well-known/oauth-protected-resource/mcp"`,
                      }
                    : {},
                );
                return response.end();
              }
              const message = JSON.parse(body) as {
                id?: number;
                method: string;
                params?: { arguments?: unknown };
              };
              if (message.id === undefined) {
                response.writeHead(202);
                return response.end();
              }
              const result =
                message.method === "initialize"
                  ? {
                      protocolVersion: "2025-06-18",
                      capabilities: { tools: {} },
                      serverInfo: { name: "fake", version: "1" },
                    }
                  : message.method === "tools/list"
                    ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
                    : {
                        content: [
                          { type: "text", text: JSON.stringify(message.params?.arguments) },
                        ],
                      };
              json(response, 200, { jsonrpc: "2.0", id: message.id, result });
            });
          });
          server.listen(0, "127.0.0.1", () => {
            const address = server.address() as { port: number };
            (fake as { base: string }).base = `http://127.0.0.1:${address.port}`;
            resolve({ server, fake });
          });
        }),
    ),
    ({ server }) => Effect.promise(() => new Promise<void>((done) => server.close(() => done()))),
  ).pipe(Effect.map(({ fake }) => fake));

const shared = (url: string, headers: Record<string, string> = {}): SharedMcpServer => ({
  id: "fake",
  name: "fake",
  url,
  args: [],
  env: {},
  enabled: true,
  headers,
});

/** A newline-delimited JSON-RPC MCP server on stdio whose one tool echoes `GREETING` from its env. */
const LOCAL_SERVER_SOURCE = `
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.method === "initialize") {
      reply(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "local", version: "1" } });
    } else if (message.method === "tools/list") {
      reply(message.id, { tools: [{ name: "greet", inputSchema: { type: "object" } }] });
    } else if (message.method === "tools/call") {
      reply(message.id, { content: [{ type: "text", text: process.env.GREETING + " " + message.params.arguments.who }] });
    }
  }
});
`;

describe("SharedMcpProxy", () => {
  it.effect("signs in once with OAuth, then lists and calls tools with the stored token", () =>
    Effect.gen(function* () {
      const fake = yield* fakeUpstream({
        oauth: true,
        authorized: (request) => request.headers.authorization === "Bearer good-token",
      });
      const proxy = yield* SharedMcpProxy.SharedMcpProxy;
      const server = shared(`${fake.base}/mcp`);

      const before = yield* proxy.probe(server).pipe(Effect.flip);
      assert.isTrue(before.needsSignIn, before.message);

      const { authorizationUrl } = yield* proxy.startSignIn(server, "http://t3.local:3773");
      assert.isNotNull(authorizationUrl);
      const authorize = new URL(authorizationUrl!);
      assert.equal(`${authorize.origin}${authorize.pathname}`, `${fake.base}/authorize`);
      assert.equal(
        authorize.searchParams.get("redirect_uri"),
        "http://t3.local:3773/api/mcp-oauth/callback",
      );
      assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");

      const finished = yield* proxy.finishSignIn(authorize.searchParams.get("state")!, "the-code");
      assert.equal(finished.server, "fake");
      // PKCE: the token request proves it started the sign-in.
      assert.isNotEmpty(fake.tokenRequests[0]?.get("code_verifier") ?? "");

      assert.deepEqual(yield* proxy.probe(server), { serverName: "fake", toolCount: 1 });
      const called = yield* proxy.callTool(server, { name: "echo", arguments: { q: "hi" } });
      assert.deepEqual(called, { content: [{ type: "text", text: '{"q":"hi"}' }] });

      // The callback's state is single-use.
      const replay = yield* proxy
        .finishSignIn(authorize.searchParams.get("state")!, "the-code")
        .pipe(Effect.flip);
      assert.include(replay.message, "expired");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("sends a server's saved headers, and reports a refusal without asking to sign in", () =>
    Effect.gen(function* () {
      const fake = yield* fakeUpstream({
        oauth: false,
        authorized: (request) => request.headers.authorization === "Bearer k-123",
      });
      const proxy = yield* SharedMcpProxy.SharedMcpProxy;

      assert.deepEqual(
        yield* proxy.probe(shared(`${fake.base}/mcp`, { Authorization: "Bearer k-123" })),
        {
          serverName: "fake",
          toolCount: 1,
        },
      );
      // A changed header is a new connection, not the cached one.
      const refused = yield* proxy
        .probe(shared(`${fake.base}/mcp`, { Authorization: "Bearer wrong" }))
        .pipe(Effect.flip);
      // A refused token is fixed by editing the header, not by an OAuth sign-in.
      assert.isFalse(refused.needsSignIn);
      assert.include(refused.message, "refused the saved Authorization header");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("starts a local program with its env and calls its tools over stdio", () =>
    Effect.gen(function* () {
      const proxy = yield* SharedMcpProxy.SharedMcpProxy;
      const local: SharedMcpServer = {
        id: "local",
        name: "local",
        command: process.execPath,
        args: ["-e", LOCAL_SERVER_SOURCE],
        env: { GREETING: "hello" },
        enabled: true,
        headers: {},
      };

      assert.deepEqual(yield* proxy.probe(local), { serverName: "local", toolCount: 1 });
      assert.deepEqual(
        yield* proxy.callTool(local, { name: "greet", arguments: { who: "nelson" } }),
        {
          content: [{ type: "text", text: "hello nelson" }],
        },
      );
      const signIn = yield* proxy.startSignIn(local, "http://t3.local:3773").pipe(Effect.flip);
      assert.isFalse(signIn.needsSignIn);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
