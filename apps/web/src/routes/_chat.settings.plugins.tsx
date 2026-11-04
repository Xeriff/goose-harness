import { createFileRoute } from "@tanstack/react-router";

import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { GoosePluginsSettings } from "../goose/GoosePluginsSettings";

function SettingsPluginsRoute() {
  return (
    <SettingsPageContainer>
      <GoosePluginsSettings />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/plugins")({
  component: SettingsPluginsRoute,
});
