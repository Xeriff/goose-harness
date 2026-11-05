import {
  defineServerPlugin,
  type GooseHttpRequest,
  type GooseHttpResponse,
  type GooseMcpServerInfo,
  type GooseServerPluginContext,
  type JsonValue,
} from "@t3tools/goose-plugin-api";

import {
  AtlassianClient,
  BitbucketSource,
  DEFAULT_JQL,
  JiraSource,
  type McpAdmin,
} from "./atlassian.ts";
import { GitHubSource } from "./github.ts";
import { ListCache } from "./list-cache.ts";
import type { WorkSource } from "./model.ts";
import { WorkItemsService, startPrompt } from "./service.ts";

export interface MyWorkConfig {
  readonly atlassian?: {
    /** Set false to hide Jira and Bitbucket. */
    readonly enabled?: boolean;
    /** Server name in Settings → MCP servers (default "atlassian"). */
    readonly server?: string;
    /** Cloud id, hostname or URL; unset uses the first site the account can access. */
    readonly site?: string;
    readonly jql?: string;
    /** Unset finds your only workspace; "none" hides Bitbucket. */
    readonly bitbucketWorkspace?: string;
  };
  readonly github?: { readonly enabled?: boolean };
  /** Start of the branch Start work suggests, before the issue key (default "feature/"). */
  readonly branchPrefix?: string;
}

const CONFIG_KEY = "config";

class BadRequest extends Error {}

function asConfig(value: unknown): MyWorkConfig {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as MyWorkConfig)
    : {};
}

function build(ctx: GooseServerPluginContext, config: MyWorkConfig, admin: McpAdmin) {
  const sources: Array<WorkSource> = [];
  let atlassian: AtlassianClient | undefined;
  if (config.atlassian?.enabled !== false) {
    atlassian = new AtlassianClient(() => admin, {
      server: config.atlassian?.server?.trim() || "atlassian",
      ...(config.atlassian?.site?.trim() ? { site: config.atlassian.site.trim() } : {}),
      jql: config.atlassian?.jql?.trim() || DEFAULT_JQL,
      ...(config.atlassian?.bitbucketWorkspace?.trim()
        ? { bitbucketWorkspace: config.atlassian.bitbucketWorkspace.trim() }
        : {}),
    });
    sources.push(new JiraSource(atlassian));
    if (config.atlassian?.bitbucketWorkspace?.trim() !== "none") {
      sources.push(new BitbucketSource(atlassian));
    }
  }
  if (config.github?.enabled === true) sources.push(new GitHubSource());
  const branchPrefix = config.branchPrefix?.trim();
  const service = new WorkItemsService(
    sources,
    new ListCache(`${ctx.dataDir}/last-list.json`),
    branchPrefix ? { branchPrefix } : {},
  );
  return { service, atlassian };
}

/**
 * Host half of My work. Jira and Bitbucket come from the Atlassian server in
 * Settings → MCP servers, so they share its sign-in; GitHub comes from the user's `gh`.
 */
export default defineServerPlugin({
  activate: async (ctx) => {
    let servers: ReadonlyArray<GooseMcpServerInfo> = [];
    const admin: McpAdmin = {
      servers: () => servers,
      listTools: (server) => ctx.mcp.listTools(server),
      callTool: (server, tool, args) => ctx.mcp.callTool(server, tool, args),
    };
    let config = asConfig(await ctx.settings.get(CONFIG_KEY));
    let current = build(ctx, config, admin);

    const field = (request: GooseHttpRequest, key: string) => {
      const value =
        request.method === "GET"
          ? request.query.get(key)
          : (request.body as Record<string, unknown> | undefined)?.[key];
      if (typeof value !== "string" || value === "") throw new BadRequest(`${key} is required`);
      return value;
    };

    // Source failures (signed out, gh missing, Jira refusing a transition) are the user's to read.
    const route = (
      method: "GET" | "POST" | "PUT",
      path: string,
      handle: (request: GooseHttpRequest) => Promise<unknown>,
    ) =>
      ctx.http.route(method, path, async (request): Promise<GooseHttpResponse> => {
        try {
          servers = await ctx.mcp.servers();
          return { body: (await handle(request)) as JsonValue };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { status: error instanceof BadRequest ? 400 : 502, body: { error: message } };
        }
      });

    route("GET", "/config", async () => ({
      config: config as JsonValue,
      defaultJql: DEFAULT_JQL,
      servers: servers.map((server) => server.name),
    }));
    route("PUT", "/config", async (request) => {
      config = asConfig(request.body);
      await ctx.settings.set(CONFIG_KEY, config as JsonValue);
      current = build(ctx, config, admin);
      return { ok: true };
    });
    route("GET", "/saved", async () => current.service.saved() ?? { sources: null });
    route("GET", "/list", () => current.service.list());
    route("GET", "/detail", (request) =>
      current.service.detail(field(request, "source"), field(request, "id")),
    );
    route("GET", "/actions", async (request) => ({
      actions: await current.service.actions(field(request, "source"), field(request, "id")),
    }));
    route("POST", "/apply", async (request) => {
      await current.service.apply(
        field(request, "source"),
        field(request, "id"),
        field(request, "actionId"),
      );
      return { ok: true };
    });
    route("GET", "/prompt", async (request) => {
      const detail = await current.service.detail(field(request, "source"), field(request, "id"));
      const branch = request.query.get("createBranch") === "true" ? detail.branch : undefined;
      return { prompt: startPrompt(detail, branch ? { branch } : {}) };
    });
    route("GET", "/review", async (request) => ({
      prompt: await current.service.reviewPrompt(field(request, "source"), field(request, "id")),
    }));
    route("GET", "/diagnose", async () => ({
      report: current.atlassian
        ? await current.atlassian.diagnose()
        : "Jira and Bitbucket are turned off in Settings → Plugins → My work.",
    }));
  },
});
