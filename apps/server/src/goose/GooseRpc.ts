import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { GoosePluginError, WS_METHODS } from "@t3tools/contracts";

import * as GooseExtensionHost from "./GooseExtensionHost.ts";

/** The `goose.*` RPC handlers ws.ts spreads into its group; each calls one host method. */
export const handlers = Effect.gen(function* () {
  const host = yield* GooseExtensionHost.GooseExtensionHost;
  return {
    [WS_METHODS.gooseListPlugins]: (_input: unknown) => host.list,
    [WS_METHODS.gooseSetPluginEnabled]: (input: {
      readonly pluginId: string;
      readonly enabled: boolean;
    }) =>
      host.setEnabled(input.pluginId, input.enabled).pipe(
        Effect.catchTags({
          GoosePluginNotFoundError: (error) =>
            Effect.fail(
              new GoosePluginError({
                pluginId: error.pluginId,
                reason: "not_found",
                message: error.message,
              }),
            ),
        }),
      ),
    [WS_METHODS.goosePluginRequest]: Effect.fn("GooseRpc.pluginRequest")(function* (input: {
      readonly pluginId: string;
      readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      readonly path: string;
      readonly query?: Readonly<Record<string, string>>;
      readonly body?: unknown;
    }) {
      const response = yield* host
        .handleRequest(input.pluginId, {
          method: input.method,
          path: input.path,
          query: new URLSearchParams(input.query ?? {}),
          headers: {},
          body: input.body,
        })
        .pipe(
          Effect.catchTags({
            GoosePluginCallError: (error) =>
              Effect.logWarning("Goose plugin request failed", {
                plugin: error.pluginId,
                operation: error.operation,
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new GoosePluginError({
                      pluginId: input.pluginId,
                      reason: "failed",
                      message: error.message,
                    }),
                  ),
                ),
              ),
          }),
        );
      if (Option.isNone(response)) {
        return yield* new GoosePluginError({
          pluginId: input.pluginId,
          reason: "not_found",
          message: `Plugin ${input.pluginId} has no ${input.method} ${input.path} route.`,
        });
      }
      return { status: response.value.status ?? 200, body: response.value.body ?? null };
    }),
  };
});
