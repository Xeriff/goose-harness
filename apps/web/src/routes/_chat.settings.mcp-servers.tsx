import { createFileRoute } from "@tanstack/react-router";

import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { SharedMcpServersSettings } from "../components/settings/SharedMcpServersSettings";

function SettingsMcpServersRoute() {
  return (
    <SettingsPageContainer>
      <SharedMcpServersSettings />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/mcp-servers")({
  component: SettingsMcpServersRoute,
});
