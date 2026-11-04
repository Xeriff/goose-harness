import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- plugin tools are declared at runtime; handle() admits only agent threads
import { McpSchema, McpServer } from "effect/ai";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as GooseExtensionHost from "./GooseExtensionHost.ts";

/** Adds every active plugin's tools to T3 Code's MCP server, so each provider's agents can call them. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const host = yield* GooseExtensionHost.GooseExtensionHost;
    for (const tool of yield* host.tools) {
      // oxlint-disable-next-line t3code/no-raw-mcp-registration -- see the import above
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: tool.name,
          description: tool.definition.description,
          inputSchema: tool.definition.inputSchema,
          annotations: {
            readOnlyHint: tool.definition.readOnly === true,
            destructiveHint: tool.definition.readOnly !== true,
            openWorldHint: true,
          },
        }),
        annotations: Context.empty(),
        handle: (payload) =>
          Effect.withFiber((fiber) => {
            const invocation = Context.getOrUndefined(
              fiber.context,
              McpInvocationContext.McpInvocationContext,
            );
            // Outside MCP clients (OAuth apps, linked environments) have narrower grants; plugin tools serve agents only.
            const threadId = invocation?.thread?.threadId;
            if (threadId === undefined) {
              return Effect.succeed(
                new McpSchema.CallToolResult({
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: "Plugin tools can only be called by an agent in a T3 Code thread.",
                    },
                  ],
                }),
              );
            }
            const args =
              payload !== null && typeof payload === "object"
                ? (payload as Record<string, unknown>)
                : {};
            return host.callTool(tool, args, threadId).pipe(
              Effect.map(
                (result) =>
                  new McpSchema.CallToolResult({
                    isError: result.isError,
                    content: [{ type: "text", text: result.text }],
                  }),
              ),
            );
          }),
      });
    }
  }),
);
