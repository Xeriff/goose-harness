import type { EnvironmentId } from "@t3tools/contracts";
import type { GooseWebPlugin } from "@t3tools/goose-plugin-api/web";

import { isElectron } from "../env";
import { RenderErrorBoundary } from "../components/RenderErrorBoundary";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import {
  isWebPluginBundled,
  useGoosePluginList,
  useGooseWebContext,
  useGooseWebPlugins,
} from "./plugins";

function PluginPageBody({
  pluginId,
  environmentId,
  page: Page,
  path,
}: {
  readonly pluginId: string;
  readonly environmentId: EnvironmentId;
  readonly page: NonNullable<GooseWebPlugin["page"]>;
  readonly path: string;
}) {
  const ctx = useGooseWebContext(pluginId, environmentId);
  return (
    <RenderErrorBoundary
      resetKeys={[pluginId, path]}
      fallback={<PluginMessage title="This plugin's page crashed" />}
    >
      <Page ctx={ctx} path={path} />
    </RenderErrorBoundary>
  );
}

function PluginMessage({
  title,
  description,
}: {
  readonly title: string;
  readonly description?: string | null;
}) {
  return (
    <Empty className="flex-1">
      <EmptyHeader className="max-w-md">
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
    </Empty>
  );
}

/** `/plugins/<id>/*`: the plugin's own page, in the app shell. */
export function GoosePluginPage({ pluginId, path }: { pluginId: string; path: string }) {
  const { query, plugins: statuses } = useGoosePluginList();
  const { environmentId, plugins } = useGooseWebPlugins();
  const status = statuses.find((candidate) => candidate.id === pluginId);
  const loaded = plugins.find((candidate) => candidate.status.id === pluginId);
  const title = status?.displayName ?? pluginId;

  let body;
  if (loaded?.plugin.page && environmentId !== null) {
    body = (
      <PluginPageBody
        pluginId={pluginId}
        environmentId={environmentId}
        page={loaded.plugin.page}
        path={path}
      />
    );
  } else if (query.data === null && query.error === null) {
    body = null;
  } else if (status === undefined) {
    body = <PluginMessage title="Plugin not found" description={query.error} />;
  } else if (status.state !== "active") {
    body = (
      <PluginMessage
        title={`${title} is ${status.state === "failed" ? "not working" : "turned off"}`}
        description={status.error ?? "Turn it on in Settings → Plugins."}
      />
    );
  } else if (!isWebPluginBundled(pluginId)) {
    body = (
      <PluginMessage
        title={`${title} has no page in this app`}
        description="Only plugins in the repo's plugins folder are built into the app."
      />
    );
  } else if (loaded && !loaded.plugin.page) {
    body = <PluginMessage title={`${title} has no page`} />;
  } else {
    body = null;
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <span className="text-sm font-medium text-foreground">{title}</span>
        </WorkspacePageHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{body}</div>
      </div>
    </SidebarInset>
  );
}
