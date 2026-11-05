import { defineServerPlugin } from "@t3tools/goose-plugin-api";

export default defineServerPlugin({
  activate: async (ctx) => {
    const count = async () => {
      const value = await ctx.storage.get("clicks");
      return typeof value === "number" ? value : 0;
    };

    ctx.http.route("GET", "/clicks", async () => ({ body: { clicks: await count() } }));
    ctx.http.route("POST", "/clicks", async () => {
      const clicks = (await count()) + 1;
      await ctx.storage.set("clicks", clicks);
      return { body: { clicks } };
    });

    // Agents see this as `example_clicks`.
    ctx.mcp.registerTool({
      name: "clicks",
      description: "How many times the user pressed the button on the Example page.",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
      handler: async () => ({ text: String(await count()) }),
    });

    ctx.log.info("Example plugin active");
  },
});
