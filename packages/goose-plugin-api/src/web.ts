import type { ComponentType } from "react";

import type { GooseHttpMethod, JsonValue } from "./index.ts";

export interface GooseWebResponse {
  readonly status: number;
  readonly body: JsonValue;
}

/** What a plugin's web half can do. Every call goes over the environment's own connection, so it works remotely too. */
export interface GooseWebContext {
  readonly pluginId: string;
  readonly environmentId: string;
  /** Calls one of this plugin's server routes. Rejects when the route is missing or throws. */
  readonly request: (
    method: GooseHttpMethod,
    path: string,
    options?: { readonly query?: Record<string, string>; readonly body?: JsonValue },
  ) => Promise<GooseWebResponse>;
  /** Opens a new thread with the prompt in its composer. The user reviews it and sends it. */
  readonly openNewThread: (draft: {
    readonly prompt: string;
    /** `owner/name`, matched against the user's projects. */
    readonly repository?: string;
    readonly provider?: string;
    readonly model?: string;
  }) => void;
  /** Navigates to a path of this plugin's page, starting with `/`. */
  readonly navigate: (path: string) => void;
}

export interface GooseSidebarItem {
  readonly label: string;
  readonly icon?: ComponentType<{ readonly className?: string }>;
  /** Path of this plugin's page, starting with `/`. Defaults to `/`. */
  readonly path?: string;
}

export interface GooseCommand {
  /** Unique within the plugin. */
  readonly id: string;
  readonly label: string;
  readonly keywords?: ReadonlyArray<string>;
  readonly run: (ctx: GooseWebContext) => void | Promise<void>;
}

/** The default export of a plugin's `web` module. */
export interface GooseWebPlugin {
  /** Rendered at `/plugins/<id>/*`; `path` is the part after the id, starting with `/`. */
  readonly page?: ComponentType<{ readonly ctx: GooseWebContext; readonly path: string }>;
  readonly sidebarItems?: ReadonlyArray<GooseSidebarItem>;
  /** Rendered under the plugin in Settings → Plugins. */
  readonly settings?: ComponentType<{ readonly ctx: GooseWebContext }>;
  /** Shown in the command palette. */
  readonly commands?: ReadonlyArray<GooseCommand>;
}

export const defineWebPlugin = (plugin: GooseWebPlugin): GooseWebPlugin => plugin;
