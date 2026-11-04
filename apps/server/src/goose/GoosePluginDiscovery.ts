import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { GOOSE_PLUGIN_API_VERSION, type GoosePluginManifest } from "@t3tools/goose-plugin-api";

const PluginId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,47}$/));

const ManifestSchema = Schema.Struct({
  id: PluginId,
  displayName: Schema.String,
  description: Schema.optionalKey(Schema.String),
  apiVersion: Schema.Number,
  server: Schema.optionalKey(Schema.String),
  web: Schema.optionalKey(Schema.String),
  enabledByDefault: Schema.optionalKey(Schema.Boolean),
});

const PackageJsonSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  goose: Schema.optionalKey(Schema.Unknown),
});

const decodePackageJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageJsonSchema));
const decodeManifest = Schema.decodeUnknownEffect(ManifestSchema);

export type PluginSource = "repo" | "user";

export interface DiscoveredPlugin {
  readonly manifest: GoosePluginManifest;
  readonly version: string;
  readonly dir: string;
  readonly source: PluginSource;
  /** Absolute path of the server entry, checked to stay inside `dir`. */
  readonly serverEntry: string | undefined;
}

export interface DiscoveryProblem {
  readonly dir: string;
  readonly reason: string;
}

export interface DiscoveryResult {
  readonly plugins: ReadonlyArray<DiscoveredPlugin>;
  readonly problems: ReadonlyArray<DiscoveryProblem>;
}

/**
 * Reads every direct child of each root that has a package.json with a `goose`
 * field. Folders without one are ignored; malformed manifests are reported,
 * never thrown, so one bad plugin cannot stop the others from loading.
 */
export const discoverPlugins = Effect.fn("GoosePluginDiscovery.discoverPlugins")(function* (
  roots: ReadonlyArray<{ readonly dir: string; readonly source: PluginSource }>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const plugins: Array<DiscoveredPlugin> = [];
  const problems: Array<DiscoveryProblem> = [];
  const seen = new Map<string, string>();

  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root.dir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const entry of [...entries].sort()) {
      const dir = path.join(root.dir, entry);
      const raw = yield* fileSystem
        .readFileString(path.join(dir, "package.json"))
        .pipe(Effect.option);
      if (raw._tag === "None") continue;

      const pkg = yield* decodePackageJson(raw.value).pipe(Effect.option);
      if (pkg._tag === "None") {
        problems.push({ dir, reason: "package.json is not valid JSON." });
        continue;
      }
      if (pkg.value.goose === undefined) continue;

      const manifest = yield* decodeManifest(pkg.value.goose).pipe(Effect.option);
      if (manifest._tag === "None") {
        problems.push({
          dir,
          reason:
            "The goose manifest needs an id (lowercase letters, digits, dashes), displayName and apiVersion.",
        });
        continue;
      }
      const { id } = manifest.value;
      if (manifest.value.apiVersion !== GOOSE_PLUGIN_API_VERSION) {
        problems.push({
          dir,
          reason: `Plugin ${id} targets plugin API ${manifest.value.apiVersion}; this host supports ${GOOSE_PLUGIN_API_VERSION}.`,
        });
        continue;
      }
      const previous = seen.get(id);
      if (previous !== undefined) {
        problems.push({ dir, reason: `Plugin id ${id} is already used by ${previous}.` });
        continue;
      }

      let serverEntry: string | undefined;
      if (manifest.value.server !== undefined) {
        serverEntry = path.resolve(dir, manifest.value.server);
        const relative = path.relative(dir, serverEntry);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          problems.push({ dir, reason: `Plugin ${id}'s server entry is outside its folder.` });
          continue;
        }
      }

      seen.set(id, dir);
      plugins.push({
        manifest: manifest.value,
        version: pkg.value.version ?? "0.0.0",
        dir,
        source: root.source,
        serverEntry,
      });
    }
  }

  return { plugins, problems } satisfies DiscoveryResult;
});
