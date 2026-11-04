import type { GooseMcpCallResult, GooseMcpToolInfo } from "@t3tools/goose-plugin-api";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { SharedMcpProxy } from "../mcp/SharedMcpProxy.ts";
import { ServerSettingsService } from "../serverSettings.ts";

export class GooseSharedMcpError extends Schema.TaggedError<GooseSharedMcpError>()(
  "GooseSharedMcpError",
  { server: Schema.String, message: Schema.String },
) {}

/** Paging guard: a server that keeps returning cursors is cut off rather than looped on forever. */
const MAX_TOOL_PAGES = 50;

interface ToolsPage {
  readonly tools?: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly inputSchema?: unknown;
  }>;
  readonly nextCursor?: string;
}

interface CallToolResponse {
  readonly isError?: boolean;
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly structuredContent?: unknown;
}

/**
 * Plugins' direct line to the servers in Settings → MCP servers. It goes through the same
 * proxy agents use, so headers and OAuth tokens stay in the secret store and connections are shared.
 */
export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const proxy = yield* SharedMcpProxy;

  const enabledServer = Effect.fn("GooseSharedMcp.enabledServer")(function* (name: string) {
    const settings = yield* settingsService.getSettings;
    const server = settings.sharedMcpServers.find((entry) => entry.name === name);
    if (server === undefined) {
      return yield* new GooseSharedMcpError({
        server: name,
        message: `No MCP server named "${name}" in Settings → MCP servers.`,
      });
    }
    if (!server.enabled) {
      return yield* new GooseSharedMcpError({
        server: name,
        message: `MCP server "${name}" is turned off.`,
      });
    }
    return server;
  });

  const servers = Effect.fn("GooseSharedMcp.servers")(function* () {
    const settings = yield* settingsService.getSettings;
    return settings.sharedMcpServers.map(({ name, url, command, enabled }) => ({
      name,
      enabled,
      ...(url === undefined ? {} : { url }),
      ...(command === undefined ? {} : { command }),
    }));
  });

  const listTools = Effect.fn("GooseSharedMcp.listTools")(function* (name: string) {
    const server = yield* enabledServer(name);
    const tools: Array<GooseMcpToolInfo> = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = (yield* proxy.listTools(
        server,
        cursor === undefined ? {} : { cursor },
      )) as ToolsPage;
      for (const tool of result.tools ?? []) {
        tools.push({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          inputSchema: tool.inputSchema ?? { type: "object" },
        });
      }
      cursor = result.nextCursor;
      if (cursor === undefined) break;
    }
    return tools;
  });

  const callTool = Effect.fn("GooseSharedMcp.callTool")(function* (
    name: string,
    tool: string,
    args: Record<string, unknown>,
  ) {
    const server = yield* enabledServer(name);
    const result = (yield* proxy.callTool(server, {
      name: tool,
      arguments: args,
    })) as CallToolResponse;
    return {
      isError: result.isError === true,
      content: result.content ?? [],
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent }),
    } satisfies GooseMcpCallResult;
  });

  return { servers, listTools, callTool };
});
