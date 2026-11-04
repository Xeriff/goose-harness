import { createFileRoute } from "@tanstack/react-router";

import { GoosePluginPage } from "../goose/GoosePluginPage";

function PluginRoute() {
  const { pluginId, _splat } = Route.useParams();
  return <GoosePluginPage pluginId={pluginId} path={`/${_splat ?? ""}`} />;
}

export const Route = createFileRoute("/_chat/plugins/$pluginId/$")({
  component: PluginRoute,
});
