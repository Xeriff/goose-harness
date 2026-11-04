import type { EnvironmentId, GoosePluginStatus } from "@t3tools/contracts";
import type { GooseWebPlugin } from "@t3tools/goose-plugin-api/web";

import { RenderErrorBoundary } from "../components/RenderErrorBoundary";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import { Badge } from "../components/ui/badge";
import { Switch } from "../components/ui/switch";
import { useAtomCommand } from "../state/use-atom-command";
import {
  gooseEnvironment,
  isWebPluginBundled,
  useGoosePluginList,
  useGooseWebContext,
  useGooseWebPlugins,
} from "./plugins";

/** A changed switch only takes effect when the server restarts and loads plugins again. */
const restartPending = (status: GoosePluginStatus) =>
  status.enabled ? status.state === "disabled" : status.state === "active";

function PluginSettingsPanel({
  pluginId,
  environmentId,
  panel: Panel,
}: {
  readonly pluginId: string;
  readonly environmentId: EnvironmentId;
  readonly panel: NonNullable<GooseWebPlugin["settings"]>;
}) {
  const ctx = useGooseWebContext(pluginId, environmentId);
  return (
    <RenderErrorBoundary
      resetKeys={[pluginId]}
      fallback={<p className="text-xs text-destructive-foreground">This panel crashed.</p>}
    >
      <Panel ctx={ctx} />
    </RenderErrorBoundary>
  );
}

function pluginDescription(status: GoosePluginStatus) {
  const parts = [status.description, `Version ${status.version}`];
  if (status.tools.length > 0) parts.push(`Agent tools: ${status.tools.join(", ")}`);
  if (status.hasWeb && !isWebPluginBundled(status.id)) {
    parts.push("Its web UI only appears when the plugin is in the repo's plugins folder.");
  }
  return parts.filter(Boolean).join(" · ");
}

export function GoosePluginsSettings() {
  const { environmentId, query, plugins } = useGoosePluginList();
  const { plugins: loaded } = useGooseWebPlugins();
  const setEnabled = useAtomCommand(gooseEnvironment.setEnabled, { label: "plugin toggle" });
  const problems = query.data?.problems ?? [];

  return (
    <SettingsSection {...searchableSetting("goose-plugins")}>
      {plugins.length === 0 ? (
        <SettingsRow
          title={query.error ? "Could not load plugins" : "No plugins installed"}
          description={
            query.error ??
            "Plugins live in the repo's plugins folder or in goose/plugins under the T3 home."
          }
        />
      ) : null}
      {plugins.map((status) => {
        const Panel = loaded.find((entry) => entry.status.id === status.id)?.plugin.settings;
        return (
          <SettingsRow
            key={status.id}
            title={
              <span className="flex items-center gap-2">
                {status.displayName}
                {status.source === "user" ? <Badge variant="outline">User</Badge> : null}
                {status.state === "failed" ? <Badge variant="error">Failed</Badge> : null}
                {restartPending(status) ? (
                  <Badge variant="warning">Restart the server to apply</Badge>
                ) : null}
              </span>
            }
            description={pluginDescription(status)}
            status={status.error ?? undefined}
            control={
              <Switch
                checked={status.enabled}
                disabled={environmentId === null}
                aria-label={`Turn ${status.displayName} on`}
                onCheckedChange={(enabled) => {
                  if (environmentId === null) return;
                  void setEnabled({ environmentId, input: { pluginId: status.id, enabled } });
                }}
              />
            }
          >
            {Panel && environmentId !== null ? (
              <div className="pt-3">
                <PluginSettingsPanel
                  pluginId={status.id}
                  environmentId={environmentId}
                  panel={Panel}
                />
              </div>
            ) : null}
          </SettingsRow>
        );
      })}
      {problems.map((problem) => (
        <SettingsRow
          key={problem.dir}
          title={<Badge variant="error">Not loaded</Badge>}
          description={`${problem.dir}: ${problem.reason}`}
        />
      ))}
    </SettingsSection>
  );
}
