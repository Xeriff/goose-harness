import { useNavigate } from "@tanstack/react-router";
import { PuzzleIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { pluginPageHref } from "./links";
import { useGooseWebPlugins } from "./plugins";

/** Plugins' sidebar entries, drawn with the sidebar's own utility button. */
export function GooseSidebarItems({
  item: Item,
  onNavigate,
}: {
  readonly item: ComponentType<{ icon: ReactNode; label: string; onClick: () => void }>;
  readonly onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const { plugins } = useGooseWebPlugins();
  return plugins.flatMap(({ status, plugin }) =>
    (plugin.sidebarItems ?? []).map((entry) => {
      const Icon = entry.icon ?? PuzzleIcon;
      return (
        <Item
          key={`${status.id}:${entry.path ?? "/"}:${entry.label}`}
          icon={<Icon />}
          label={entry.label}
          onClick={() => {
            onNavigate();
            void navigate({ href: pluginPageHref(status.id, entry.path) });
          }}
        />
      );
    }),
  );
}
