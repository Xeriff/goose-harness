import * as Schema from "effect/Schema";

// Goose Harness plugins. Each plugin's own data stays `Unknown` here; its server and web halves agree on it.

export const GoosePluginState = Schema.Literals(["active", "disabled", "failed"]);
export type GoosePluginState = typeof GoosePluginState.Type;

export const GoosePluginStatus = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  description: Schema.NullOr(Schema.String),
  version: Schema.String,
  source: Schema.Literals(["repo", "user"]),
  enabled: Schema.Boolean,
  state: GoosePluginState,
  error: Schema.NullOr(Schema.String),
  tools: Schema.Array(Schema.String),
  hasWeb: Schema.Boolean,
});
export type GoosePluginStatus = typeof GoosePluginStatus.Type;

export const GoosePluginList = Schema.Struct({
  plugins: Schema.Array(GoosePluginStatus),
  problems: Schema.Array(Schema.Struct({ dir: Schema.String, reason: Schema.String })),
});
export type GoosePluginList = typeof GoosePluginList.Type;

export const GoosePluginSetEnabledInput = Schema.Struct({
  pluginId: Schema.String,
  enabled: Schema.Boolean,
});

export const GoosePluginHttpMethod = Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"]);
export type GoosePluginHttpMethod = typeof GoosePluginHttpMethod.Type;

/** A call to one of a plugin's routes, carried over the environment's RPC connection. */
export const GoosePluginRequestInput = Schema.Struct({
  pluginId: Schema.String,
  method: GoosePluginHttpMethod,
  path: Schema.String.check(Schema.isPattern(/^\//)),
  query: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  body: Schema.optionalKey(Schema.Json),
});
export type GoosePluginRequestInput = typeof GoosePluginRequestInput.Type;

export const GoosePluginResponse = Schema.Struct({
  status: Schema.Number,
  body: Schema.Json,
});
export type GoosePluginResponse = typeof GoosePluginResponse.Type;

export class GoosePluginError extends Schema.TaggedError<GoosePluginError>()("GoosePluginError", {
  pluginId: Schema.String,
  reason: Schema.Literals(["not_found", "failed"]),
  message: Schema.String,
}) {}
