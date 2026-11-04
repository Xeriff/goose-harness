declare module "virtual:goose-web-plugins" {
  import type { GooseWebPlugin } from "@t3tools/goose-plugin-api/web";

  export const webPlugins: ReadonlyArray<{
    readonly id: string;
    readonly load: () => Promise<{ readonly default: GooseWebPlugin }>;
  }>;
}
