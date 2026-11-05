# Writing a plugin

A plugin is a folder with a `package.json` whose `goose` field is its manifest. It can have
a server half, a web half, or both. [`plugins/my-work`](../plugins/my-work) is a full
example. [`goose/plugin-template`](plugin-template) is the smallest working one.

## Start from the template

```sh
cp -r goose/plugin-template plugins/<id>
```

Then, in the new `package.json`, set `name` to `@t3tools/goose-plugin-<id>` and set
`goose.id`, `displayName` and `description`. Run `vp i` so the workspace picks it up, and
restart `vp run dev`. The plugin starts turned off. Turn it on in Settings → Plugins, then
restart the server.

## Where plugins come from

| Location                       | Server half | Web half                |
| ------------------------------ | ----------- | ----------------------- |
| `plugins/*` in this repo       | yes         | bundled into the client |
| `<T3 home>/goose/plugins/*`    | yes         | not shown               |
| folders in `GOOSE_PLUGIN_DIRS` | yes         | not shown               |

`GOOSE_PLUGIN_DIRS` is separated by `:`, or by `;` on Windows. The client is built ahead of time, so only repo plugins get a web half. A plugin outside
the repo can still serve routes and agent tools. Settings → Plugins says when its UI is
missing.

## Manifest

```json
"goose": {
  "id": "example",
  "displayName": "Example",
  "description": "One line for Settings → Plugins.",
  "apiVersion": 1,
  "server": "src/server.ts",
  "web": "src/web.tsx",
  "enabledByDefault": false
}
```

- `id` is lowercase letters, digits and dashes, at most 48 characters, and unique.
- `apiVersion` must match `GOOSE_PLUGIN_API_VERSION` in
  [`packages/goose-plugin-api`](../packages/goose-plugin-api/src/index.ts), or the host
  refuses the plugin.
- `server` and `web` are paths inside the plugin folder.

## Server half

The server half's default export is `defineServerPlugin({ activate, deactivate? })`.
`activate(ctx)` registers everything:

- `ctx.http.route(method, path, handler)` serves `/api/goose/plugins/<id><path>` behind the
  server's own sign-in. GET needs read access. Other methods need operate access.
- `ctx.mcp.registerTool(tool)` gives every agent on every provider a tool named
  `<id>_<name>`.
- `ctx.mcp.servers()`, `listTools(server)` and `callTool(server, tool, args)` call the
  servers in Settings → MCP servers with the headers and sign-in saved there.
- `ctx.events.on(type, handler)` observes committed agent events. Handlers can't block or
  change a turn.
- `ctx.settings` and `ctx.storage` are per-plugin JSON stores, and `ctx.secrets` uses
  the server's secret store. `ctx.dataDir` is a folder the plugin can write files to.

Things that are easy to get wrong:

- **Node loads the server half as is,** with its types stripped. Use only erasable
  TypeScript: no enums, no parameter properties, and `.ts` in relative imports. Import
  runtime code only from `@t3tools/goose-plugin-api` and Node built-ins. Anything else
  has to be a dependency in the plugin's own `package.json`.
- **Time limits:** `activate` has 10 seconds, route handlers 30, and event handlers 5. A
  plugin that throws or runs out of time during `activate` is marked failed, and the
  others keep running.
- **A route handler that throws** reaches the client as a generic "Plugin failed" error.
  To show the user a reason, catch the error and return
  `{ status: 4xx/5xx, body: { error } }` instead, as My work does.
- **Plugins run with the server's full permissions.** Install only plugins you trust.

## Web half

The web half's default export is `defineWebPlugin({ page, sidebarItems, settings, commands })`
from `@t3tools/goose-plugin-api/web`:

- `page` renders at `/plugins/<id>/*`.
- `sidebarItems` link to that page.
- `settings` renders under the plugin in Settings → Plugins.
- `commands` appear in the command palette.

Each of these receives a `ctx`:

- `ctx.request(method, path, { query, body })` calls the plugin's own routes over the
  environment's connection, so it works remotely too. It resolves with `{ status, body }`
  for any status the handler returned.
- `ctx.openNewThread({ prompt, repository?, provider?, model? })` opens a draft with the
  prompt for the user to review and send. `repository` is a GitHub `owner/name`.
- `ctx.navigate(path)` moves within the plugin's page.

Style the web half with the app's Tailwind tokens, such as `bg-card`, `border-border`,
`text-muted-foreground` and `bg-primary`. Plugins can't import the app's own components.
The web half shows on web and desktop, not on mobile.

## Checks

Repo plugins and the template are workspace packages, so `vp run check:changed` formats,
lints, typechecks and tests them. Put tests beside the code as `*.test.ts`, using
`vite-plus/test`. The template's `server.test.ts` shows a stand-in host.

Their `tsconfig.json` turns off the Effect rules for Node built-ins, dates and timers,
because plugin code is plain promises. The other repo lint rules still apply.
