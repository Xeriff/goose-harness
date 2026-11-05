/**
 * The API a Goose Harness plugin is written against. It is deliberately small,
 * promise-based and independent of T3 Code's internals, so plugins keep working
 * while upstream changes underneath. `GOOSE_PLUGIN_API_VERSION` bumps on any
 * breaking change; the host refuses plugins built for another major version.
 */
export const GOOSE_PLUGIN_API_VERSION = 1;

/** The `goose` field of a plugin's package.json. */
export interface GoosePluginManifest {
  /** Lowercase letters, digits and dashes; unique across installed plugins. */
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  /** Major version of this API the plugin targets. */
  readonly apiVersion: number;
  /** Module, relative to the package root, whose default export is a `GooseServerPlugin`. */
  readonly server?: string;
  /** Module, relative to the package root, for the web client (stage 3). */
  readonly web?: string;
  /** Whether a freshly discovered plugin starts enabled. Defaults to false. */
  readonly enabledByDefault?: boolean;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

export interface GoosePluginLogger {
  readonly info: (message: string, fields?: Record<string, unknown>) => void;
  readonly warn: (message: string, fields?: Record<string, unknown>) => void;
  readonly error: (message: string, fields?: Record<string, unknown>) => void;
}

/** Per-plugin JSON values, persisted by the host. Settings are what the user edits; storage is the plugin's own. */
export interface GoosePluginStore {
  readonly get: (key: string) => Promise<JsonValue | undefined>;
  readonly set: (key: string, value: JsonValue) => Promise<void>;
  readonly delete: (key: string) => Promise<void>;
  readonly keys: () => Promise<ReadonlyArray<string>>;
}

/** Secrets kept in T3 Code's secret store, namespaced to the plugin. Never logged or sent to clients. */
export interface GoosePluginSecrets {
  readonly get: (name: string) => Promise<string | undefined>;
  readonly set: (name: string, value: string) => Promise<void>;
  readonly delete: (name: string) => Promise<void>;
}

export interface GooseHttpRequest {
  readonly method: string;
  /** Path below the plugin's prefix, starting with `/`. */
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Parsed JSON body, or undefined when there is none. */
  readonly body: unknown;
}

export interface GooseHttpResponse {
  readonly status?: number;
  /** Sent as JSON. */
  readonly body?: JsonValue;
}

export type GooseHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Plugin HTTP routes are served at `/api/goose/plugins/<id><path>` behind the
 * server's own authentication. `GET` needs read access, other methods operate access.
 */
export interface GoosePluginHttp {
  readonly route: (
    method: GooseHttpMethod,
    path: string,
    handler: (request: GooseHttpRequest) => Promise<GooseHttpResponse> | GooseHttpResponse,
  ) => void;
}

/** A committed orchestration event, reduced to fields that are stable across upstream versions. */
export interface GooseAgentEvent {
  readonly sequence: number;
  /** For example `thread.created`, `run.created`, `run.updated`, `message`. */
  readonly type: string;
  readonly threadId: string;
  readonly runId?: string;
  readonly occurredAt: string;
  /** The event's own payload as T3 Code encodes it. Shape may change with upstream. */
  readonly payload: unknown;
}

/** Observe-only: handlers run after the event committed and can never block or change a turn. */
export interface GoosePluginEvents {
  readonly on: (
    type: string | ReadonlyArray<string> | "*",
    handler: (event: GooseAgentEvent) => Promise<void> | void,
  ) => void;
}

export interface GooseToolCallContext {
  /** The thread whose agent called the tool. */
  readonly threadId: string;
}

export interface GooseToolResult {
  readonly text: string;
  readonly isError?: boolean;
}

export interface GooseToolDefinition {
  /** Exposed to agents as `<pluginId>_<name>`. Lowercase letters, digits and underscores. */
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments object. */
  readonly inputSchema: { readonly type: "object"; readonly [key: string]: unknown };
  readonly readOnly?: boolean;
  readonly handler: (
    args: Record<string, unknown>,
    context: GooseToolCallContext,
  ) => Promise<GooseToolResult> | GooseToolResult;
}

export interface GooseMcpServerInfo {
  readonly name: string;
  /** A remote server's address; a local program has `command` instead. */
  readonly url?: string;
  readonly command?: string;
  readonly enabled: boolean;
}

export interface GooseMcpToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

export interface GooseMcpCallResult {
  readonly isError: boolean;
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly structuredContent?: unknown;
}

/**
 * Tools reach every agent, on every provider, through T3 Code's built-in MCP server.
 * The other methods call the servers in Settings → MCP servers directly, outside a chat,
 * with the headers and sign-in saved there. Calls to a disabled or unknown server reject.
 */
export interface GoosePluginMcp {
  readonly registerTool: (tool: GooseToolDefinition) => void;
  readonly servers: () => Promise<ReadonlyArray<GooseMcpServerInfo>>;
  readonly listTools: (server: string) => Promise<ReadonlyArray<GooseMcpToolInfo>>;
  readonly callTool: (
    server: string,
    tool: string,
    args?: Record<string, unknown>,
  ) => Promise<GooseMcpCallResult>;
}

export interface GooseServerPluginContext {
  readonly pluginId: string;
  /** Directory this plugin's package lives in. */
  readonly pluginDir: string;
  /** A directory the plugin may write its own files to. */
  readonly dataDir: string;
  readonly log: GoosePluginLogger;
  readonly settings: GoosePluginStore;
  readonly storage: GoosePluginStore;
  readonly secrets: GoosePluginSecrets;
  readonly http: GoosePluginHttp;
  readonly events: GoosePluginEvents;
  readonly mcp: GoosePluginMcp;
}

export interface GooseServerPlugin {
  /** Register routes, tools and hooks here. Must finish within the host's activation timeout. */
  readonly activate: (context: GooseServerPluginContext) => Promise<void> | void;
  /** Called when the server stops. */
  readonly deactivate?: () => Promise<void> | void;
}

/** Identity helper that gives plugin authors type checking. */
export const defineServerPlugin = (plugin: GooseServerPlugin): GooseServerPlugin => plugin;
