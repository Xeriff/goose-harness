import { useRouter } from "@tanstack/react-router";
import { PuzzleIcon } from "lucide-react";

import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../components/CommandPalette.logic";
import { createGooseWebContext, useGooseWebPlugins } from "./plugins";

/** Plugins' own commands, plus one to open each plugin's page. */
export function useGoosePaletteItems(): ReadonlyArray<CommandPaletteActionItem> {
  const router = useRouter();
  const { environmentId, plugins } = useGooseWebPlugins();
  if (environmentId === null) return [];
  return plugins.flatMap(({ status, plugin }) => {
    const ctx = createGooseWebContext(status.id, environmentId, router);
    const icon = <PuzzleIcon className={ITEM_ICON_CLASS} />;
    const items: Array<CommandPaletteActionItem> = (plugin.commands ?? []).map((command) => ({
      kind: "action",
      value: `action:goose:${status.id}:${command.id}`,
      searchTerms: [command.label, status.displayName, ...(command.keywords ?? [])],
      title: command.label,
      description: status.displayName,
      icon,
      run: async () => {
        await command.run(ctx);
      },
    }));
    if (plugin.page) {
      items.unshift({
        kind: "action",
        value: `action:goose:${status.id}:open`,
        searchTerms: [status.displayName, "plugin", "open"],
        title: `Open ${status.displayName}`,
        icon,
        run: async () => ctx.navigate("/"),
      });
    }
    return items;
  });
}
