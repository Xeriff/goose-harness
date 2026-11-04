// @effect-diagnostics-next-line nodeBuiltinImport:off -- Vite config runs before any Effect runtime.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Vite config runs before any Effect runtime.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import type { Plugin } from "vite-plus";

const VIRTUAL_ID = "virtual:goose-web-plugins";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
const PLUGIN_ID = /^[a-z][a-z0-9-]{0,47}$/;

interface WebEntry {
  readonly id: string;
  readonly entry: string;
}

/** Repo plugins whose manifest names a `web` module. The server decides which of them are active. */
function scanRepoPlugins(pluginsDir: string): ReadonlyArray<WebEntry> {
  if (!NodeFS.existsSync(pluginsDir)) return [];
  const entries: Array<WebEntry> = [];
  for (const name of NodeFS.readdirSync(pluginsDir).toSorted()) {
    const dir = NodePath.join(pluginsDir, name);
    let goose: { id?: unknown; web?: unknown } | undefined;
    try {
      goose = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "package.json"), "utf8")).goose;
    } catch {
      continue;
    }
    if (typeof goose?.id !== "string" || !PLUGIN_ID.test(goose.id)) continue;
    if (typeof goose.web !== "string") continue;
    const entry = NodePath.resolve(dir, goose.web);
    const relative = NodePath.relative(dir, entry);
    if (relative.startsWith("..") || NodePath.isAbsolute(relative)) continue;
    entries.push({ id: goose.id, entry });
  }
  return entries;
}

/** Bundles the web halves of the repo's `plugins/*` into the client as lazy chunks. */
export function gooseWebPlugins(): Plugin {
  const pluginsDir = NodeURL.fileURLToPath(new URL("../../../plugins", import.meta.url));
  return {
    name: "goose:web-plugins",
    config: () => ({ resolve: { dedupe: ["react", "react-dom", "@t3tools/goose-plugin-api"] } }),
    resolveId: (id) => (id === VIRTUAL_ID ? RESOLVED_ID : undefined),
    configureServer(server) {
      // A plugin added or removed while dev runs changes the list, so rebuild it and reload.
      server.watcher.add(pluginsDir);
      const onChange = (file: string) => {
        if (!file.startsWith(pluginsDir) || NodePath.basename(file) !== "package.json") return;
        const module = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (module) server.moduleGraph.invalidateModule(module);
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("add", onChange);
      server.watcher.on("change", onChange);
      server.watcher.on("unlink", onChange);
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      const entries = scanRepoPlugins(pluginsDir);
      const items = entries.map(
        ({ id: pluginId, entry }) =>
          `{ id: ${JSON.stringify(pluginId)}, load: () => import(${JSON.stringify(entry)}) }`,
      );
      return `export const webPlugins = [${items.join(", ")}];\n`;
    },
  };
}
