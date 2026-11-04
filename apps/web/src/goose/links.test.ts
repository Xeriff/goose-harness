import { parseNewThreadLink } from "@t3tools/shared/promptLinks";
import { describe, expect, it } from "vite-plus/test";

import { newThreadDraftHref, pluginPageHref } from "./links";

describe("newThreadDraftHref", () => {
  it("builds a /new link the prompt-link route reads back", () => {
    const href = newThreadDraftHref({
      prompt: "Fix PROJ-123 & ship",
      repository: "acme/web",
      provider: "Claude",
      model: "haiku",
    });
    expect(href.startsWith("/new?")).toBe(true);
    expect(parseNewThreadLink(href.slice("/new".length))).toEqual({
      ok: true,
      value: {
        kind: "new",
        prompt: { text: "Fix PROJ-123 & ship", hiddenCharacters: 0 },
        repository: { owner: "acme", name: "web" },
        provider: "claude",
        model: "haiku",
      },
    });
  });
});

describe("pluginPageHref", () => {
  it("keeps the plugin's own path below its page", () => {
    expect(pluginPageHref("my-work")).toBe("/plugins/my-work/");
    expect(pluginPageHref("my-work", "issues/PROJ-1")).toBe("/plugins/my-work/issues/PROJ-1");
  });
});
