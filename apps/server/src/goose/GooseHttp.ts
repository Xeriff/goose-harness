import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
} from "@t3tools/contracts";
import type { GooseHttpMethod } from "@t3tools/goose-plugin-api";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { requestUrl } from "../requestUrl.ts";
import * as GooseExtensionHost from "./GooseExtensionHost.ts";

const GOOSE_ROUTE_PREFIX = "/api/goose/plugins";
const GOOSE_HOST_ROUTE_PREFIX = "/api/goose/host";
const MAX_BODY_BYTES = 1024 * 1024;
const NO_STORE = { "cache-control": "no-store" };
const METHODS: ReadonlyArray<GooseHttpMethod> = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const json = (status: number, body: unknown) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE });

type Scope =
  | typeof AuthOrchestrationReadScope
  | typeof AuthOrchestrationOperateScope
  | typeof AuthSettingsWriteScope;

/** `None` when the request may continue; otherwise the error response to send. */
const authorize = Effect.fn("GooseHttp.authorize")(function* (scope: Scope) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
  if (Option.isNone(session)) return Option.some(json(401, { error: "unauthorized" }));
  if (!session.value.scopes.includes(scope)) {
    return Option.some(json(403, { error: "forbidden", scope }));
  }
  return Option.none();
});

const readJsonBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const length = request.headers["content-length"];
  if (length === undefined || length === "0") return Option.some<unknown>(undefined);
  if (Number(length) > MAX_BODY_BYTES) return Option.none<unknown>();
  return yield* request.json.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
    Effect.option,
  );
});

const makeRoutes = (host: GooseExtensionHost.GooseExtensionHost["Service"]) => {
  const listRoute = HttpRouter.add(
    "GET",
    `${GOOSE_HOST_ROUTE_PREFIX}/plugins`,
    Effect.gen(function* () {
      const denied = yield* authorize(AuthOrchestrationReadScope);
      if (Option.isSome(denied)) return denied.value;
      return json(200, yield* host.list);
    }),
  );

  const decodeEnabledBody = Schema.decodeUnknownEffect(Schema.Struct({ enabled: Schema.Boolean }));

  const enabledRoute = HttpRouter.add(
    "PUT",
    `${GOOSE_HOST_ROUTE_PREFIX}/plugins/:pluginId/enabled`,
    Effect.gen(function* () {
      const denied = yield* authorize(AuthSettingsWriteScope);
      if (Option.isSome(denied)) return denied.value;
      const { pluginId } = yield* HttpRouter.params;
      const body = yield* readJsonBody.pipe(
        Effect.flatMap(Effect.fromOption),
        Effect.flatMap(decodeEnabledBody),
        Effect.option,
      );
      if (pluginId === undefined || Option.isNone(body)) {
        return json(400, { error: 'Send {"enabled": true|false}.' });
      }
      return yield* host.setEnabled(pluginId, body.value.enabled).pipe(
        Effect.map((result) => json(200, result)),
        Effect.catchTags({
          GoosePluginNotFoundError: (error) => Effect.succeed(json(404, { error: error.message })),
        }),
      );
    }),
  );

  const dispatch = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const method = METHODS.find((candidate) => candidate === request.method);
    const url = requestUrl(request);
    if (method === undefined || Option.isNone(url))
      return json(405, { error: "method_not_allowed" });

    const denied = yield* authorize(
      method === "GET" ? AuthOrchestrationReadScope : AuthOrchestrationOperateScope,
    );
    if (Option.isSome(denied)) return denied.value;

    const rest = url.value.pathname.slice(GOOSE_ROUTE_PREFIX.length + 1);
    const slash = rest.indexOf("/");
    const pluginId = slash === -1 ? rest : rest.slice(0, slash);
    const path = slash === -1 ? "/" : rest.slice(slash);
    const body = yield* readJsonBody;
    if (Option.isNone(body)) return json(400, { error: "The body must be JSON, at most 1 MB." });

    const response = yield* host
      .handleRequest(pluginId, {
        method,
        path,
        query: url.value.searchParams,
        headers: request.headers,
        body: body.value,
      })
      .pipe(
        Effect.catchTags({
          GoosePluginCallError: (error) =>
            Effect.logWarning("Goose plugin route failed", {
              plugin: error.pluginId,
              operation: error.operation,
            }).pipe(Effect.as(Option.some({ status: 500, body: { error: "plugin_error" } }))),
        }),
      );
    if (Option.isNone(response)) return json(404, { error: "not_found" });
    return json(response.value.status ?? 200, response.value.body ?? null);
  });

  const pluginRoute = (method: GooseHttpMethod) =>
    HttpRouter.add(method, `${GOOSE_ROUTE_PREFIX}/:pluginId/*`, dispatch);

  return Layer.mergeAll(
    listRoute,
    enabledRoute,
    pluginRoute("GET"),
    pluginRoute("POST"),
    pluginRoute("PUT"),
    pluginRoute("PATCH"),
    pluginRoute("DELETE"),
  );
};

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    return makeRoutes(yield* GooseExtensionHost.GooseExtensionHost);
  }),
);
