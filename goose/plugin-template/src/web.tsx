import { defineWebPlugin, type GooseWebContext } from "@t3tools/goose-plugin-api/web";
import { MousePointerClickIcon } from "lucide-react";
import { useEffect, useState } from "react";

function Page({ ctx }: { readonly ctx: GooseWebContext }) {
  const [clicks, setClicks] = useState<number>();

  useEffect(() => {
    void ctx.request("GET", "/clicks").then((response) => {
      setClicks((response.body as { clicks: number }).clicks);
    });
  }, [ctx]);

  const click = async () => {
    const response = await ctx.request("POST", "/clicks");
    setClicks((response.body as { clicks: number }).clicks);
  };

  return (
    <div className="flex flex-col items-start gap-3 p-4 text-sm">
      <p>Clicked {clicks ?? "…"} times.</p>
      <button
        type="button"
        className="h-8 rounded-md bg-primary px-3 text-primary-foreground hover:bg-primary/90"
        onClick={() => void click()}
      >
        Click
      </button>
      <button
        type="button"
        className="h-8 rounded-md border border-border px-3 hover:bg-accent"
        onClick={() =>
          ctx.openNewThread({ prompt: "How many clicks does the Example plugin show?" })
        }
      >
        Ask an agent
      </button>
    </div>
  );
}

export default defineWebPlugin({
  page: Page,
  sidebarItems: [{ label: "Example", icon: MousePointerClickIcon }],
  commands: [{ id: "open", label: "Open Example", run: (ctx) => ctx.navigate("/") }],
});
