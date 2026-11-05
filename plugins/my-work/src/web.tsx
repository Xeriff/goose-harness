import { defineWebPlugin, type GooseWebContext } from "@t3tools/goose-plugin-api/web";
import { ListTodoIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { startWorkAction, type StatusAction, type WorkItem, type WorkItemDetail } from "./model.ts";
import type { MyWorkConfig } from "./server.ts";
import type { SourceList } from "./service.ts";

type Source = WorkItem["source"];
type Query = Record<string, string>;

const SOURCE_LABEL: Record<Source, string> = {
  jira: "Jira",
  bitbucket: "Bitbucket",
  github: "GitHub",
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function get<T>(ctx: GooseWebContext, path: string, query?: Query): Promise<T> {
  return unwrap<T>(await ctx.request("GET", path, query ? { query } : {}));
}

async function send<T>(
  ctx: GooseWebContext,
  method: "POST" | "PUT",
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  return unwrap<T>(await ctx.request(method, path, { body: body as never }));
}

function unwrap<T>(response: { status: number; body: unknown }): T {
  if (response.status >= 400) {
    const body = response.body as { error?: unknown } | null;
    throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`);
  }
  return response.body as T;
}

/** A GitHub item's `owner/repo`, which the new thread uses to pick the project. */
const githubRepository = (item: WorkItem) =>
  item.source === "github" ? item.container : undefined;

function MyWorkPage({ ctx }: { readonly ctx: GooseWebContext }) {
  const [lists, setLists] = useState<ReadonlyArray<SourceList>>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Source | "all">("all");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<WorkItem>();
  const [report, setReport] = useState<string>();
  const [updatedAt, setUpdatedAt] = useState<number>();
  const [failure, setFailure] = useState<string>();

  const diagnose = async () => {
    setReport("Checking…");
    try {
      setReport((await get<{ report: string }>(ctx, "/diagnose")).report);
    } catch (error) {
      setReport(errorText(error));
    }
  };

  // The list on screen stays while a refresh runs, and stays if the refresh fails.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const fresh = await get<{ sources: Array<SourceList>; at: number }>(ctx, "/list");
      setLists(fresh.sources);
      setUpdatedAt(fresh.at);
      setFailure(undefined);
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setLoading(false);
    }
  }, [ctx]);

  useEffect(() => {
    let live = true;
    void get<{ sources: Array<SourceList> | null; at?: number }>(ctx, "/saved")
      .then(
        (saved) => {
          if (!live || !saved.sources) return;
          const sources = saved.sources;
          setLists((current) => (current.length === 0 ? sources : current));
          setUpdatedAt((current) => current ?? saved.at);
        },
        () => {},
      )
      .finally(() => {
        if (live) void refresh();
      });
    return () => {
      live = false;
    };
  }, [ctx, refresh]);

  // Links between PRs and issues use every loaded item, whatever the tab and filter.
  const everything = useMemo(() => lists.flatMap((list) => list.items), [lists]);
  const items = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return lists
      .filter((list) => tab === "all" || list.source === tab)
      .flatMap((list) => list.items)
      .filter(
        (item) =>
          !needle ||
          `${item.id} ${item.title} ${item.container ?? ""} ${item.status} ${(item.issueKeys ?? []).join(" ")}`
            .toLowerCase()
            .includes(needle),
      )
      .toSorted((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
  }, [lists, tab, filter]);
  const visible = (list: SourceList) => tab === "all" || tab === list.source;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="h-8 w-full max-w-xs rounded-md border border-input bg-background px-2"
          placeholder="Filter by key, title, project…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <PlainButton onClick={() => void refresh()} disabled={loading}>
          {loading ? "Updating…" : "Refresh"}
        </PlainButton>
        {updatedAt !== undefined ? (
          <span className="text-xs text-muted-foreground">Updated {since(updatedAt)}</span>
        ) : null}
        <PlainButton onClick={() => void diagnose()}>Diagnose</PlainButton>
      </div>
      {report ? (
        <div className="flex flex-col gap-2 rounded-md border border-border p-2">
          <pre className="font-mono text-xs break-words whitespace-pre-wrap">{report}</pre>
          <div className="flex gap-2">
            <PlainButton onClick={() => void navigator.clipboard?.writeText(report)}>
              Copy
            </PlainButton>
            <PlainButton onClick={() => setReport(undefined)}>Close</PlainButton>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        <Tab active={tab === "all"} onClick={() => setTab("all")}>
          All ({everything.length}
          {lists.some((list) => list.more) ? "+" : ""})
        </Tab>
        {lists.map((list) => (
          <Tab key={list.source} active={tab === list.source} onClick={() => setTab(list.source)}>
            {SOURCE_LABEL[list.source]} ({list.items.length}
            {list.more ? "+" : ""}){list.error ? " ⚠" : ""}
          </Tab>
        ))}
      </div>
      {lists
        .filter((list) => list.more && visible(list))
        .map((list) => (
          <Muted key={list.source}>
            {SOURCE_LABEL[list.source]}: showing {list.items.length} of {list.total ?? "more"}.{" "}
            {list.source === "jira"
              ? "Narrow the JQL in Settings → Plugins → My work to see the rest."
              : `Open ${SOURCE_LABEL[list.source]} to see the rest.`}
          </Muted>
        ))}
      {failure ? <ErrorText>Couldn't refresh: {failure}</ErrorText> : null}
      {lists
        .filter((list) => list.error && visible(list))
        .map((list) => (
          <ErrorText key={list.source}>
            {SOURCE_LABEL[list.source]}: {list.error}
            {list.staleSince !== undefined
              ? ` Showing the list from ${since(list.staleSince)}.`
              : ""}
          </ErrorText>
        ))}
      {lists.length === 0 && loading ? <Muted>Loading your work…</Muted> : null}
      {lists.length === 0 && !loading && !failure ? (
        <Muted>
          No sources are on. Add the Atlassian server in Settings → MCP servers, or turn on GitHub
          in Settings → Plugins → My work.
        </Muted>
      ) : null}
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex w-2/5 min-w-64 flex-col gap-1.5 overflow-y-auto">
          {items.length === 0 && !loading ? <Muted>Nothing here.</Muted> : null}
          {items.map((item) => (
            <button
              type="button"
              key={`${item.source}:${item.id}`}
              className={`flex flex-col gap-1 rounded-md border border-border px-2.5 py-2 text-left hover:bg-accent ${
                selected?.source === item.source && selected.id === item.id ? "bg-accent" : ""
              }`}
              onClick={() => setSelected(item)}
            >
              <span className="flex flex-wrap items-center gap-1.5">
                <Key>{item.id}</Key>
                <StatusBadge status={item.status} category={item.statusCategory} />
                {item.kind === "review" ? <Muted>review</Muted> : null}
                {item.issueKeys?.map((key) => (
                  <IssueKey key={key} issueKey={key} items={everything} onSelect={setSelected} />
                ))}
              </span>
              <span className="font-medium">{item.title}</span>
              <Muted>
                {[
                  SOURCE_LABEL[item.source],
                  item.container,
                  item.type,
                  item.priority,
                  item.updated && relative(item.updated),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Muted>
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto border-l border-border pl-3">
          {selected ? (
            <DetailPane
              key={`${selected.source}:${selected.id}`}
              ctx={ctx}
              item={selected}
              items={everything}
              onSelect={setSelected}
              onChanged={() => void refresh()}
            />
          ) : (
            <Muted>Select a task to see its details.</Muted>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailPane({
  ctx,
  item,
  items,
  onSelect,
  onChanged,
}: {
  readonly ctx: GooseWebContext;
  readonly item: WorkItem;
  readonly items: ReadonlyArray<WorkItem>;
  readonly onSelect: (item: WorkItem) => void;
  readonly onChanged: () => void;
}) {
  const [detail, setDetail] = useState<WorkItemDetail>();
  const [actions, setActions] = useState<Array<StatusAction>>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [moveToProgress, setMoveToProgress] = useState(true);
  const [createBranch, setCreateBranch] = useState(true);
  // A fresh copy loads the detail again; the pane is keyed by the item, so it never goes stale.
  const [ref, setRef] = useState(() => ({ source: item.source, id: item.id }));

  useEffect(() => {
    let live = true;
    void Promise.all([
      get<WorkItemDetail>(ctx, "/detail", ref),
      get<{ actions: Array<StatusAction> }>(ctx, "/actions", ref).then(
        (result) => result.actions,
        () => [],
      ),
    ]).then(
      ([loaded, available]) => {
        if (!live) return;
        setDetail(loaded);
        setActions(available);
        setError(undefined);
      },
      (cause) => {
        if (live) setError(errorText(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [ctx, ref]);

  const progressAction = startWorkAction(actions);
  const shown: WorkItemDetail = detail ?? { ...item, facts: [] };

  const run = async (label: string, task: () => Promise<unknown>) => {
    setBusy(label);
    setError(undefined);
    try {
      await task();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const applyAction = (action: StatusAction) =>
    run(action.label, async () => {
      await send(ctx, "POST", "/apply", { ...ref, actionId: action.id });
      setRef({ ...ref });
      onChanged();
    });

  const openThread = (prompt: string) => {
    const repository = githubRepository(item);
    ctx.openNewThread({ prompt, ...(repository ? { repository } : {}) });
  };

  const startWork = () =>
    run("Start work", async () => {
      const { prompt } = await get<{ prompt: string }>(ctx, "/prompt", {
        ...ref,
        createBranch: String(Boolean(detail?.branch) && createBranch),
      });
      if (moveToProgress && progressAction && shown.statusCategory !== "in-progress") {
        await send(ctx, "POST", "/apply", { ...ref, actionId: progressAction.id });
        onChanged();
      }
      openThread(prompt);
    });

  const review = () =>
    run("Review", async () => {
      openThread((await get<{ prompt: string }>(ctx, "/review", ref)).prompt);
    });

  const isPr = item.kind !== "issue";
  // PRs from the loaded lists that name this issue in their title or branch.
  const pullRequests =
    item.source === "jira"
      ? items.filter((other) => other.source !== "jira" && other.issueKeys?.includes(item.id))
      : [];
  const issueKeys = shown.issueKeys ?? item.issueKeys ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Key>{shown.id}</Key>
        <StatusBadge status={shown.status} category={shown.statusCategory} />
        {shown.url ? (
          <a
            href={shown.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:underline"
          >
            Open in {SOURCE_LABEL[shown.source]}
          </a>
        ) : null}
      </div>
      <h3 className="text-base font-semibold">{shown.title}</h3>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {!detail && !error ? <Muted>Loading…</Muted> : null}

      <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-2.5">
        <div className="flex flex-wrap gap-2">
          {item.kind !== "review" ? (
            <PrimaryButton disabled={Boolean(busy)} onClick={() => void startWork()}>
              {busy === "Start work" ? "Starting…" : "Start work"}
            </PrimaryButton>
          ) : null}
          {isPr ? (
            <PlainButton disabled={Boolean(busy)} onClick={() => void review()}>
              {busy === "Review" ? "Reading the diff…" : "Review in a thread"}
            </PlainButton>
          ) : null}
        </div>
        {detail?.branch ? (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={createBranch}
              onChange={(event) => setCreateBranch(event.target.checked)}
            />
            Ask to create the branch <Key>{detail.branch}</Key> first
          </label>
        ) : null}
        {progressAction && shown.statusCategory !== "in-progress" ? (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={moveToProgress}
              onChange={(event) => setMoveToProgress(event.target.checked)}
            />
            Also move to "{progressAction.to ?? progressAction.label}"
          </label>
        ) : null}
        <Muted>
          Opens a new thread with the task in the message box. Pick the model there, review the
          message, then send it.
        </Muted>
      </div>

      {issueKeys.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Label>Linked {issueKeys.length === 1 ? "issue" : "issues"}</Label>
          {issueKeys.map((key) => (
            <IssueKey key={key} issueKey={key} items={items} onSelect={onSelect} />
          ))}
        </div>
      ) : null}
      {pullRequests.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <Label>Pull requests</Label>
          {pullRequests.map((pr) => (
            <button
              type="button"
              key={`${pr.source}:${pr.id}`}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-left hover:bg-accent"
              onClick={() => onSelect(pr)}
            >
              <Key>{pr.id}</Key>
              <StatusBadge status={pr.status} category={pr.statusCategory} />
              <span>{pr.title}</span>
            </button>
          ))}
        </div>
      ) : null}

      {actions && actions.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <Label>Change status</Label>
          <div className="flex flex-wrap gap-1.5">
            {actions.map((action) => (
              <PlainButton
                key={action.id}
                disabled={Boolean(busy)}
                onClick={() => void applyAction(action)}
              >
                {busy === action.label ? "…" : action.label}
                {action.to && action.to !== action.label ? ` → ${action.to}` : ""}
              </PlainButton>
            ))}
          </div>
        </div>
      ) : null}

      {shown.facts.length > 0 ? (
        <dl className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
          {shown.facts.map((fact) => (
            <div key={fact.label} className="flex flex-col">
              <dt>
                <Label>{fact.label}</Label>
              </dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {shown.description ? (
        <div className="rounded-md border border-border p-2.5 leading-relaxed whitespace-pre-wrap">
          {shown.description}
        </div>
      ) : null}
      {detail ? <Comments detail={detail} /> : null}
    </div>
  );
}

function Comments({ detail }: { readonly detail: WorkItemDetail }) {
  const comments = detail.comments ?? [];
  if (detail.commentsError)
    return <Muted>Couldn't load the comments: {detail.commentsError}</Muted>;
  if (comments.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <Label>Comments</Label>
      {detail.commentTotal !== undefined && detail.commentTotal > comments.length ? (
        <Muted>
          Showing the latest {comments.length} of {detail.commentTotal}
          {detail.url ? `; open it in ${SOURCE_LABEL[detail.source]} for the rest` : ""}.
        </Muted>
      ) : null}
      {comments.map((comment) => (
        <div
          key={`${comment.author}:${comment.created ?? ""}:${comment.body.slice(0, 40)}`}
          className="flex flex-col gap-1 rounded-md border border-border px-2.5 py-2"
        >
          <Muted>
            <strong>{comment.author}</strong>
            {comment.created ? <span> · {relative(comment.created)}</span> : null}
            {comment.note ? ` · ${comment.note}` : ""}
          </Muted>
          <div className="leading-relaxed break-words whitespace-pre-wrap">{comment.body}</div>
        </div>
      ))}
    </div>
  );
}

/** A Jira key a pull request names: a link to that issue when it is in the list. */
function IssueKey({
  issueKey,
  items,
  onSelect,
}: {
  readonly issueKey: string;
  readonly items: ReadonlyArray<WorkItem>;
  readonly onSelect: (item: WorkItem) => void;
}) {
  const issue = items.find((other) => other.source === "jira" && other.id === issueKey);
  const chip = "rounded border border-border px-1 font-mono text-[11px]";
  if (!issue) {
    return <span className={chip}>{issueKey}</span>;
  }
  // Rows are buttons themselves, so this is a span that stops the row's click.
  return (
    <span
      role="link"
      tabIndex={0}
      className={`${chip} cursor-pointer text-primary`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(issue);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.stopPropagation();
        onSelect(issue);
      }}
    >
      {issueKey}
    </span>
  );
}

function StatusBadge({
  status,
  category,
}: {
  readonly status: string;
  readonly category: WorkItem["statusCategory"];
}) {
  const tone =
    category === "done"
      ? "border-success text-success-foreground"
      : category === "in-progress"
        ? "border-primary text-primary"
        : "border-border text-muted-foreground";
  return <span className={`rounded-full border px-1.5 text-[11px] ${tone}`}>{status}</span>;
}

function Tab({
  active,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`rounded-full border border-border px-2.5 py-0.5 text-xs ${active ? "bg-accent" : "hover:bg-accent"}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function PlainButton(props: {
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="h-8 rounded-md border border-border px-2.5 hover:bg-accent disabled:opacity-60"
      {...props}
    />
  );
}

function PrimaryButton(props: {
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="h-8 rounded-md bg-primary px-3 text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
      {...props}
    />
  );
}

const Key = ({ children }: { readonly children: ReactNode }) => (
  <code className="font-mono text-xs">{children}</code>
);
const Label = ({ children }: { readonly children: ReactNode }) => (
  <span className="text-xs text-muted-foreground">{children}</span>
);
const Muted = ({ children }: { readonly children: ReactNode }) => (
  <p className="text-xs text-muted-foreground">{children}</p>
);
const ErrorText = ({ children }: { readonly children: ReactNode }) => (
  <p className="text-xs text-destructive-foreground">{children}</p>
);

function since(at: number): string {
  return Date.now() - at < 60_000 ? "just now" : relative(new Date(at).toISOString());
}

function relative(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

interface ConfigResponse {
  readonly config: MyWorkConfig;
  readonly defaultJql: string;
  readonly servers: ReadonlyArray<string>;
}

function SettingsPanel({ ctx }: { readonly ctx: GooseWebContext }) {
  const [loaded, setLoaded] = useState<ConfigResponse>();
  const [draft, setDraft] = useState<MyWorkConfig>({});
  const [status, setStatus] = useState<string>();

  useEffect(() => {
    void get<ConfigResponse>(ctx, "/config").then(
      (response) => {
        setLoaded(response);
        setDraft(response.config);
      },
      (error) => setStatus(errorText(error)),
    );
  }, [ctx]);

  if (!loaded) return status ? <ErrorText>{status}</ErrorText> : null;
  const atlassian = draft.atlassian ?? {};
  const setAtlassian = (patch: NonNullable<MyWorkConfig["atlassian"]>) =>
    setDraft({ ...draft, atlassian: { ...atlassian, ...patch } });
  const server = atlassian.server ?? "atlassian";
  const save = async () => {
    setStatus("Saving…");
    try {
      await send(ctx, "PUT", "/config", draft as Record<string, unknown>);
      setStatus("Saved.");
    } catch (error) {
      setStatus(errorText(error));
    }
  };

  return (
    <div className="flex flex-col gap-2.5 text-sm">
      <Checkbox
        checked={atlassian.enabled !== false}
        onChange={(enabled) => setAtlassian({ enabled })}
      >
        Jira and Bitbucket, through an Atlassian server in Settings → MCP servers
      </Checkbox>
      {atlassian.enabled !== false ? (
        <>
          <Field label="MCP server">
            <select
              className="h-8 rounded-md border border-input bg-background px-2"
              value={server}
              onChange={(event) => setAtlassian({ server: event.target.value })}
            >
              {[...new Set([server, ...loaded.servers])].map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <TextField
            label="Site"
            placeholder="First site you can access, or acme.atlassian.net"
            value={atlassian.site}
            onChange={(site) => setAtlassian({ site })}
          />
          <TextField
            label="JQL"
            placeholder={loaded.defaultJql}
            value={atlassian.jql}
            onChange={(jql) => setAtlassian({ jql })}
          />
          <TextField
            label="Bitbucket workspace"
            placeholder="Your only workspace; none hides Bitbucket"
            value={atlassian.bitbucketWorkspace}
            onChange={(bitbucketWorkspace) => setAtlassian({ bitbucketWorkspace })}
          />
        </>
      ) : null}
      <Checkbox
        checked={draft.github?.enabled === true}
        onChange={(enabled) => setDraft({ ...draft, github: { enabled } })}
      >
        GitHub issues and pull requests, through the gh CLI on the server
      </Checkbox>
      <TextField
        label="Branch prefix"
        placeholder="feature/"
        value={draft.branchPrefix}
        onChange={(branchPrefix) => setDraft({ ...draft, branchPrefix })}
      />
      <div className="flex items-center gap-2">
        <PrimaryButton onClick={() => void save()}>Save</PrimaryButton>
        {status ? <Muted>{status}</Muted> : null}
      </div>
    </div>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <Label>{label}</Label>
      {children}
    </label>
  );
}

function TextField({
  label,
  placeholder,
  value,
  onChange,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly value: string | undefined;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <input
        className="h-8 rounded-md border border-input bg-background px-2"
        placeholder={placeholder}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function Checkbox({
  checked,
  onChange,
  children,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly children: ReactNode;
}) {
  return (
    <label className="flex items-center gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {children}
    </label>
  );
}

export default defineWebPlugin({
  page: MyWorkPage,
  sidebarItems: [{ label: "My work", icon: ListTodoIcon }],
  settings: SettingsPanel,
  commands: [{ id: "open", label: "Open My work", run: (ctx) => ctx.navigate("/") }],
});
