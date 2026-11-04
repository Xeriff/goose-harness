import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, GoosePluginStatus } from "@t3tools/contracts";
import { createGooseEnvironmentAtoms } from "@t3tools/client-runtime/state/goose";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { GooseWebContext, GooseWebPlugin } from "@t3tools/goose-plugin-api/web";
import { type AnyRouter, useRouter } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { webPlugins } from "virtual:goose-web-plugins";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { newThreadDraftHref, pluginPageHref } from "./links";

export const gooseEnvironment = createGooseEnvironmentAtoms(connectionAtomRuntime);

const bundled = new Map(webPlugins.map((plugin) => [plugin.id, plugin.load]));

/** Whether this build carries the plugin's web half. Plugins installed outside the repo do not have one yet. */
export const isWebPluginBundled = (pluginId: string) => bundled.has(pluginId);

export interface LoadedWebPlugin {
  readonly status: GoosePluginStatus;
  readonly plugin: GooseWebPlugin;
}

// Keyed by the active ids, so turning a plugin off never loads code it no longer needs.
const loadedModules = Atom.family((ids: string) =>
  Atom.make(
    Effect.promise(() =>
      Promise.all(
        ids
          .split(",")
          .filter((id) => id.length > 0)
          .map(async (id) => {
            try {
              const loaded = await bundled.get(id)?.();
              return loaded ? ([id, loaded.default] as const) : null;
            } catch (error) {
              console.error(`Goose plugin ${id} failed to load its web module.`, error);
              return null;
            }
          }),
      ).then((entries) => new Map(entries.filter((entry) => entry !== null))),
    ),
  ).pipe(Atom.keepAlive, Atom.withLabel(`goose:web-modules:${ids}`)),
);

const EMPTY: ReadonlyArray<GoosePluginStatus> = [];

/** The primary environment's plugin list. Plugins' web halves only talk to that environment. */
export function useGoosePluginList() {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null ? null : gooseEnvironment.list({ environmentId, input: {} }),
  );
  return { environmentId, query, plugins: query.data?.plugins ?? EMPTY };
}

/** Active plugins with a web half in this build, once their modules have loaded. */
export function useGooseWebPlugins(): {
  readonly environmentId: EnvironmentId | null;
  readonly plugins: ReadonlyArray<LoadedWebPlugin>;
} {
  const { environmentId, plugins } = useGoosePluginList();
  const active = plugins.filter(
    (status) => status.state === "active" && status.hasWeb && bundled.has(status.id),
  );
  const modules = AsyncResult.getOrElse(
    useAtomValue(loadedModules(active.map((status) => status.id).join(","))),
    () => null,
  );
  const loaded = active.flatMap((status) => {
    const plugin = modules?.get(status.id);
    return plugin ? [{ status, plugin }] : [];
  });
  return { environmentId, plugins: loaded };
}

export function useGooseWebContext(
  pluginId: string,
  environmentId: EnvironmentId,
): GooseWebContext {
  return createGooseWebContext(pluginId, environmentId, useRouter());
}

export function createGooseWebContext(
  pluginId: string,
  environmentId: EnvironmentId,
  router: Pick<AnyRouter, "navigate">,
): GooseWebContext {
  return {
    pluginId,
    environmentId,
    request: async (method, path, options) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        gooseEnvironment.request,
        {
          environmentId,
          input: {
            pluginId,
            method,
            path,
            ...(options?.query === undefined ? {} : { query: options.query }),
            ...(options?.body === undefined ? {} : { body: options.body }),
          },
        },
        { reportFailure: false },
      );
      if (result._tag === "Success") return result.value;
      throw squashAtomCommandFailure(result);
    },
    openNewThread: (draft) => void router.navigate({ href: newThreadDraftHref(draft) }),
    navigate: (path) => void router.navigate({ href: pluginPageHref(pluginId, path) }),
  };
}
