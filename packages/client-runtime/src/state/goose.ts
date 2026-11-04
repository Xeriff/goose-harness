import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Goose Harness plugins on one environment: which are installed, and calls to their routes. */
export function createGooseEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // Plugins only change when the server restarts, so a list stays fresh for a while.
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:goose:list-plugins",
    tag: WS_METHODS.gooseListPlugins,
    staleTimeMs: 60_000,
  });
  return {
    list,
    setEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:goose:set-plugin-enabled",
      tag: WS_METHODS.gooseSetPluginEnabled,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    request: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:goose:plugin-request",
      tag: WS_METHODS.goosePluginRequest,
    }),
  };
}
