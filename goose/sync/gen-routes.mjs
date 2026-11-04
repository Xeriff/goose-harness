// Regenerates apps/web/src/routeTree.gen.ts the way the web build does, without a dev server.
// The sync takes upstream's copy on conflict and runs this so our own routes come back.
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

const webRoot = NodeURL.fileURLToPath(new URL("../../apps/web/", import.meta.url));
const fromPlugin = NodeModule.createRequire(
  NodeModule.createRequire(webRoot).resolve("@tanstack/router-plugin/vite"),
);
const generatorEntry = fromPlugin.resolve("@tanstack/router-generator");
const { Generator, getConfig } = await import(NodeURL.pathToFileURL(generatorEntry).href);

const config = getConfig({ autoCodeSplitting: true }, webRoot);
await new Generator({ config, root: webRoot }).run();
