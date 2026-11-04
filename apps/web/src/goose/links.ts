import type { GooseWebContext } from "@t3tools/goose-plugin-api/web";
import { buildNewThreadLink, parsePromptLinkRepository } from "@t3tools/shared/promptLinks";

export function pluginPageHref(pluginId: string, path = "/"): string {
  return `/plugins/${encodeURIComponent(pluginId)}${path.startsWith("/") ? path : `/${path}`}`;
}

/** `/new?…` for a plugin's draft; the prompt-link route checks it the same way as any shared link. */
export function newThreadDraftHref(draft: Parameters<GooseWebContext["openNewThread"]>[0]): string {
  const url = new URL(
    buildNewThreadLink({
      prompt: draft.prompt,
      repository:
        draft.repository === undefined ? null : parsePromptLinkRepository(draft.repository),
      provider: draft.provider ?? null,
      model: draft.model ?? null,
      origin: "http://goose.invalid",
    }),
  );
  return `${url.pathname}${url.search}`;
}
