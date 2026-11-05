import {
  COMMENT_LIMIT,
  LIST_LIMIT,
  categoryOf,
  issueKeysIn,
  latestComments,
  plainText,
  type SourcePage,
  type StatusAction,
  type WorkComment,
  type WorkItem,
  type WorkItemDetail,
  type WorkSource,
} from "./model.ts";

/** Direct tool calls on a server in Settings → MCP servers; `servers` is a snapshot taken per request. */
export interface McpAdmin {
  servers(): ReadonlyArray<{
    readonly name: string;
    readonly enabled: boolean;
    readonly url?: string;
  }>;
  callTool(
    server: string,
    tool: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
  listTools?(
    server: string,
    signal?: AbortSignal,
  ): Promise<
    ReadonlyArray<{
      readonly name: string;
      readonly description?: string;
      readonly inputSchema?: unknown;
    }>
  >;
}

interface ToolResult {
  isError: boolean;
  content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  structuredContent?: unknown;
}

export interface AtlassianOptions {
  /** MCP server name in Settings → MCP servers (default "atlassian"). */
  server: string;
  /** Atlassian site (cloud id, hostname or URL); default: the first site the account can access. */
  site?: string;
  /** Issues to list (default: assigned to me and not done, most recently updated first). */
  jql: string;
  /** Bitbucket workspace slug; Bitbucket pull requests are listed only when set. */
  bitbucketWorkspace?: string;
}

/** One Rovo operation, with the names it has had (v2 first) and its execute tier. */
export interface Operation {
  names: readonly string[];
  tier: "read" | "write";
  /** Natural-language goal for `discover`, used when none of the names is known to the server. */
  goal: string;
  /** Operations that take no cloudId (`omitCloudId` in the catalog). */
  noCloudId?: true;
}

export const OPERATIONS = {
  resources: {
    names: ["getAccessibleAtlassianResources"],
    tier: "read",
    goal: "list the Atlassian sites (cloud ids) I can access",
    noCloudId: true,
  },
  search: {
    names: ["searchJiraIssuesUsingJql"],
    tier: "read",
    goal: "search Jira issues with JQL",
  },
  issue: { names: ["getJiraIssue"], tier: "read", goal: "get one Jira issue by key" },
  transitions: {
    names: ["getTransitionsForJiraIssue", "listJiraIssueTransitions"],
    tier: "read",
    goal: "list the available status transitions of a Jira issue",
  },
  transition: {
    names: ["transitionJiraIssue"],
    tier: "write",
    goal: "move a Jira issue to another status with a transition id",
  },
  myPullRequests: {
    names: ["listMyBitbucketPullRequests", "getMyBitbucketPullRequests"],
    tier: "read",
    goal: "list Bitbucket pull requests I authored in a workspace",
  },
  myReviews: {
    names: ["listMyBitbucketReviewRequests", "getMyBitbucketReviewRequests"],
    tier: "read",
    goal: "list Bitbucket pull requests waiting for my review in a workspace",
  },
  pullRequest: {
    names: ["getBitbucketRepoPullRequest", "getBitbucketPullRequest"],
    tier: "read",
    goal: "get one Bitbucket pull request by workspace, repository and id",
  },
  workspaces: {
    names: ["listBitbucketWorkspaces"],
    tier: "read",
    goal: "list the Bitbucket workspaces I am a member of",
  },
  statuses: {
    names: ["listJiraStatuses"],
    tier: "read",
    goal: "list the Jira statuses of the site in one status category",
  },
  comments: {
    names: ["listJiraIssueComments", "getJiraIssueComments"],
    tier: "read",
    goal: "list the comments on a Jira issue",
  },
  pullRequestComments: {
    names: ["listBitbucketRepoPullRequestComments", "listBitbucketPullRequestComments"],
    tier: "read",
    goal: "list the comments on a Bitbucket pull request",
  },
  pullRequestDiff: {
    names: ["getBitbucketRepoPullRequestDiff", "getBitbucketPullRequestDiff"],
    tier: "read",
    goal: "get the diff of a Bitbucket pull request",
  },
} satisfies Record<string, Operation>;

export const DEFAULT_JQL =
  "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
export const RECOMMENDED_URL = "https://mcp.atlassian.com/v2/mcp";

const UNKNOWN_OPERATION =
  /unknown (operation|tool)|not (a )?(known|valid|supported) (operation|tool)|no (such )?(operation|tool)|operation .*not found|tool .*not found|does not exist/i;

// Rovo v2 lists only a few primary tools; every other operation runs through
// executeRead/executeWrite (or execute) as `{ name, cloudId, inputs }`, and names the
// server doesn't know are looked up with `discover`. v1 has no execute tools.
/** What the My work list asks Jira for: the fields its rows show. */
const LIST_QUERY = {
  maxResults: LIST_LIMIT,
  fields: ["summary", "status", "priority", "issuetype", "updated", "project"],
};

export class AtlassianClient {
  private site: Promise<string> | undefined;
  /** The site's own address (https://acme.atlassian.net), learned with its cloud id; for links. */
  siteUrl: string | undefined;
  private toolList: Promise<Set<string> | undefined> | undefined;
  /** Operation names found through `discover`, by goal. */
  private readonly discovered = new Map<string, string>();

  private readonly admin: () => McpAdmin | undefined;
  readonly options: AtlassianOptions;

  constructor(admin: () => McpAdmin | undefined, options: AtlassianOptions) {
    this.admin = admin;
    this.options = options;
  }

  /** The configured server's URL, when it has one. */
  serverUrl(): string | undefined {
    return this.admin()
      ?.servers()
      .find((server) => server.name === this.options.server)?.url;
  }

  /** Tool names the server lists; undefined when the admin can't list them. */
  tools(signal?: AbortSignal): Promise<Set<string> | undefined> {
    const admin = this.ready();
    if (!admin.listTools) return Promise.resolve(undefined);
    this.toolList ??= admin
      .listTools(this.options.server, signal)
      .then((list) => new Set(list.map((tool) => tool.name)))
      .catch((error) => {
        this.toolList = undefined;
        throw error;
      });
    return this.toolList;
  }

  /** Forgets the tool list, the site, its statuses and discovered names, e.g. after the server was edited. */
  forget(): void {
    this.toolList = undefined;
    this.site = undefined;
    this.categories = undefined;
    this.discovered.clear();
  }

  private categories: Promise<Map<string, WorkItem["statusCategory"]>> | undefined;

  /**
   * Fills in status categories a reply left out. Search replies can carry
   * only the category's translated name ("Em andamento"), so the site's
   * statuses are read once per category key (new, indeterminate, done) and
   * matched by status name. A failed lookup leaves the items as they are.
   */
  async withCategories(items: WorkItem[], signal?: AbortSignal): Promise<WorkItem[]> {
    if (!items.some((item) => item.statusCategory === "unknown")) return items;
    this.categories ??= Promise.all(
      (["new", "indeterminate", "done"] as const).map(async (key) => {
        const value = await this.run(
          OPERATIONS.statuses,
          { mode: "site", statusCategory: key },
          signal,
        );
        return {
          category: categoryOf(undefined, key),
          statuses: listOf(value, ["statuses"]) as Array<{ name?: string }>,
        };
      }),
    )
      .then((groups) => {
        const byName = new Map<string, WorkItem["statusCategory"]>();
        for (const { category, statuses } of groups) {
          for (const status of statuses)
            if (status.name && !byName.has(status.name.toLowerCase()))
              byName.set(status.name.toLowerCase(), category);
        }
        return byName;
      })
      .catch((error) => {
        this.categories = undefined;
        throw error;
      });
    const byName = await this.categories.catch(() => undefined);
    if (!byName) return items;
    return items.map((item) =>
      item.statusCategory === "unknown" && byName.has(item.status.toLowerCase())
        ? { ...item, statusCategory: byName.get(item.status.toLowerCase())! }
        : item,
    );
  }

  /** Runs one operation, directly or through execute, and returns its parsed result. */
  async run(
    operation: Operation,
    inputs: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const cloudId = operation.noCloudId ? undefined : await this.cloudId(signal);
    const tools = await this.tools(signal);
    const label = operation.names[0]!;
    try {
      const direct = operation.names.find((name) => tools?.has(name));
      if (direct)
        return await this.call(direct, { ...(cloudId ? { cloudId } : {}), ...inputs }, signal);
      // No tool list: assume the v2 primary tools are the ones we used before.
      if (
        !tools &&
        (label === "getAccessibleAtlassianResources" ||
          label === "searchJiraIssuesUsingJql" ||
          label === "getJiraIssue" ||
          label === "transitionJiraIssue" ||
          label === "listJiraIssueComments")
      ) {
        return await this.call(label, { ...(cloudId ? { cloudId } : {}), ...inputs }, signal);
      }
      const execute = this.executeTool(operation.tier, tools);
      const names = [
        ...(this.discovered.has(operation.goal) ? [this.discovered.get(operation.goal)!] : []),
        ...operation.names,
      ];
      let lastError: unknown;
      for (const name of names) {
        try {
          return await this.call(
            execute,
            { name, ...(cloudId ? { cloudId } : {}), inputs },
            signal,
          );
        } catch (error) {
          if (!UNKNOWN_OPERATION.test(messageOf(error))) throw error;
          lastError = error;
        }
      }
      const found = tools?.has("discover")
        ? await this.discover(operation.goal, signal)
        : undefined;
      if (found && !names.includes(found)) {
        this.discovered.set(operation.goal, found);
        return await this.call(
          execute,
          { name: found, ...(cloudId ? { cloudId } : {}), inputs },
          signal,
        );
      }
      throw lastError ?? new Error("the server does not offer this operation");
    } catch (error) {
      throw new Error(`${label}: ${messageOf(error)}`, { cause: error });
    }
  }

  /** Calls one tool and returns its parsed result; a tool error becomes a thrown Error with the server's text. */
  async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const admin = this.ready();
    const result = await admin.callTool(this.options.server, tool, args, signal);
    const value = resultValue(result);
    if (result.isError)
      throw new Error(
        typeof value === "string" ? value || "the tool reported an error" : JSON.stringify(value),
      );
    return unwrapData(value);
  }

  /** The site to query: the configured one, else the first accessible resource. */
  cloudId(signal?: AbortSignal): Promise<string> {
    if (this.options.site) return Promise.resolve(this.options.site);
    this.site ??= this.run(OPERATIONS.resources, {}, signal)
      .then((value) => {
        const first = listOf(value, ["resources", "sites"])[0] as
          | { id?: string; cloudId?: string; url?: string }
          | undefined;
        if (first?.url) this.siteUrl = first.url;
        const id = first?.id ?? first?.cloudId ?? first?.url;
        if (!id) {
          const said =
            typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
          throw new Error(
            `this Atlassian account has no accessible sites${said ? ` (the server said: ${clip(said, 300)})` : ""}. Set the site in Settings → Plugins → My work, e.g. acme.atlassian.net`,
          );
        }
        return String(id);
      })
      .catch((error) => {
        this.site = undefined;
        throw error;
      });
    return this.site;
  }

  /**
   * A plain-text report of each step (server, tool list, site, a one-issue
   * search) for the panel's Diagnose button. It contains no secrets: the
   * sign-in is never read here, only tool names and the server's own replies.
   */
  async diagnose(signal?: AbortSignal): Promise<string> {
    const lines: string[] = [];
    // Each step reports how long it took, so a slow list can be traced to its call.
    const step = async (label: string, run: () => Promise<string>) => {
      const started = Date.now();
      const took = () => `(${((Date.now() - started) / 1000).toFixed(1)} s)`;
      try {
        const result = await run();
        lines.push(`✓ ${label} ${took()}: ${result}`);
        return true;
      } catch (error) {
        lines.push(`✗ ${label} ${took()}: ${messageOf(error)}`);
        return false;
      }
    };
    this.forget();
    const ok = await step("MCP server", async () => {
      this.ready();
      const url = this.serverUrl();
      return `"${this.options.server}" at ${url ?? "(no URL)"}${/\/v1\//.test(url ?? "") ? ` (v1; switch to ${RECOMMENDED_URL})` : ""}`;
    });
    if (!ok) return lines.join("\n");
    await step("Tools", async () => {
      const tools = await this.tools(signal);
      return tools ? `${tools.size}: ${[...tools].sort().join(", ")}` : "unknown";
    });
    const site = await step("Site", async () =>
      this.options.site
        ? `${await this.cloudId(signal)} (from the plugin settings)`
        : await this.cloudId(signal),
    );
    if (site) {
      await step("Jira search", async () => {
        const value = await this.run(
          OPERATIONS.search,
          { jql: this.options.jql, maxResults: 1, fields: ["summary"] },
          signal,
        );
        const issues = issuesOf(value);
        return issues.length
          ? `OK, first result ${issues[0]!.key}`
          : `no issues; the server returned ${clip(typeof value === "string" ? value : JSON.stringify(value), 400)}`;
      });
      await step(
        "Full list",
        async () =>
          `${issuesOf(await this.run(OPERATIONS.search, { jql: this.options.jql, ...LIST_QUERY }, signal)).length} issues`,
      );
    }
    return lines.join("\n");
  }

  private ready(): McpAdmin {
    const admin = this.admin();
    const server = admin?.servers().find((entry) => entry.name === this.options.server);
    if (!admin || !server) {
      throw new Error(
        `no MCP server named "${this.options.server}": add Atlassian in Settings → MCP servers, or pick the server in Settings → Plugins → My work`,
      );
    }
    if (!server.enabled)
      throw new Error(
        `the MCP server "${this.options.server}" is turned off in Settings → MCP servers`,
      );
    return admin;
  }

  private executeTool(tier: Operation["tier"], tools: Set<string> | undefined): string {
    const preferred = tier === "write" ? "executeWrite" : "executeRead";
    if (!tools) return preferred;
    for (const name of [preferred, "execute"]) if (tools.has(name)) return name;
    const url = this.serverUrl();
    throw new Error(
      /\/v1\//.test(url ?? "")
        ? `"${this.options.server}" uses Atlassian's older v1 endpoint (${url}), which lacks the tools My work needs. In Settings → MCP servers choose "Switch to Atlassian v2" in its menu or change the URL to ${RECOMMENDED_URL}.`
        : `"${this.options.server}" offers none of executeRead, executeWrite or execute; is it Atlassian's Rovo MCP server at ${RECOMMENDED_URL}?`,
    );
  }

  /** Asks `discover` for an operation name; undefined when it can't say. */
  private async discover(goal: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      return namesIn(await this.call("discover", { query: goal }, signal))[0];
    } catch {
      return undefined;
    }
  }
}

/** A tool result's value: structured content when given, else its text parsed as JSON where possible. */
/**
 * Rovo MCP v2 wraps replies in a `data` envelope, e.g.
 * `{"data":{"resources":[…]}}`; v1 sent the payload bare. Unwrap it so every
 * reader sees the same shape either way.
 */
export function unwrapData(value: unknown): unknown {
  while (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (!keys.includes("data") || record.data === null || typeof record.data !== "object") break;
    // Keep an object whose payload sits beside a field that happens to be named data.
    if (keys.some((key) => PAYLOAD_KEYS.has(key))) break;
    value = record.data;
  }
  return value;
}

const PAYLOAD_KEYS = new Set([
  "resources",
  "sites",
  "issues",
  "values",
  "transitions",
  "fields",
  "key",
]);

export function resultValue(result: ToolResult): unknown {
  if (result.structuredContent !== undefined && result.structuredContent !== null)
    return result.structuredContent;
  const blocks = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "");
  const joined = blocks.join("");
  for (const text of [joined, ...blocks]) {
    const value = tryJson(text.trim());
    if (value !== undefined) return value;
  }
  // Some servers wrap the JSON in prose or a code fence.
  const embedded =
    /```(?:json)?\s*([\s\S]*?)```/.exec(joined)?.[1] ?? /[[{][\s\S]*[\]}]/.exec(joined)?.[0];
  return (embedded && tryJson(embedded.trim())) ?? joined;
}

function tryJson(text: string): unknown {
  if (!text || !/^[[{]/.test(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Operation names in a `discover` result, best match first. */
function namesIn(value: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      for (const key of ["name", "operation", "operationName"])
        if (typeof record[key] === "string") out.push(record[key] as string);
      Object.values(record).forEach(visit);
    }
  };
  visit(value);
  return [...new Set(out)];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export class JiraSource implements WorkSource {
  readonly name = "jira" as const;

  private readonly client: AtlassianClient;

  constructor(client: AtlassianClient) {
    this.client = client;
  }

  async list(signal?: AbortSignal): Promise<SourcePage> {
    const cloudId = await this.client.cloudId(signal);
    const value = await this.client.run(
      OPERATIONS.search,
      { jql: this.client.options.jql, ...LIST_QUERY },
      signal,
    );
    const items = await this.client.withCategories(
      issuesOf(value).map((issue) => this.toItem(issue, cloudId)),
      signal,
    );
    return { items, ...(await this.overflow(value, items.length, signal)) };
  }

  /**
   * Whether the search had more issues than it returned, and how many. A
   * search page says only that more exist (pageInfo, isLast or a next-page
   * token), so the total comes from one count-only search; if that fails the
   * panel still says there are more.
   */
  private async overflow(
    value: unknown,
    shown: number,
    signal?: AbortSignal,
  ): Promise<Pick<SourcePage, "more" | "total">> {
    const total = searchTotal(value);
    if (total !== undefined) return total > shown ? { more: true, total } : {};
    if (!searchHasMore(value)) return {};
    const counted = await this.client
      .run(
        OPERATIONS.search,
        {
          jql: this.client.options.jql,
          searchResultMode: "count",
          maxResults: 1,
          fields: ["summary"],
        },
        signal,
      )
      .then(searchTotal, () => undefined);
    return { more: true, ...(counted !== undefined && counted > shown ? { total: counted } : {}) };
  }

  async detail(id: string, signal?: AbortSignal): Promise<WorkItemDetail> {
    const cloudId = await this.client.cloudId(signal);
    const [value, comments] = await Promise.all([
      this.client.run(
        OPERATIONS.issue,
        { issueIdOrKey: id, responseContentFormat: "markdown" },
        signal,
      ),
      this.comments(id, signal),
    ]);
    // v2 returns the issue as a one-item search result: {"issues":{"nodes":[issue]}}.
    const issue = (
      (value as JiraIssue | undefined)?.key ? value : (issuesOf(value)[0] ?? {})
    ) as JiraIssue;
    if (!issue.key) throw new Error(`Jira returned no issue ${id}`);
    const fields = issue.fields ?? {};
    const facts: WorkItemDetail["facts"] = [];
    const person = (value: unknown) => (value as { displayName?: string } | undefined)?.displayName;
    if (person(fields.assignee)) facts.push({ label: "Assignee", value: person(fields.assignee)! });
    if (person(fields.reporter)) facts.push({ label: "Reporter", value: person(fields.reporter)! });
    if (Array.isArray(fields.labels) && fields.labels.length)
      facts.push({ label: "Labels", value: fields.labels.join(", ") });
    const parent = fields.parent as { key?: string; fields?: { summary?: string } } | undefined;
    if (parent?.key)
      facts.push({
        label: "Parent",
        value: `${parent.key} ${parent.fields?.summary ?? ""}`.trim(),
      });
    const embedded = fields.comment as { total?: number; comments?: unknown[] } | undefined;
    const count =
      comments.commentTotal ??
      (comments.comments ? comments.comments.length : undefined) ??
      embedded?.total ??
      issue.commentCount;
    if (typeof count === "number") facts.push({ label: "Comments", value: String(count) });
    // The issue can embed up to 20 comments itself; use them when the comment list could not be read.
    const fallback =
      comments.commentsError && embedded?.comments?.length
        ? jiraComments(embedded.comments, false)
        : undefined;
    const [item] = await this.client.withCategories([this.toItem(issue, cloudId)], signal);
    return {
      ...item!,
      ...(typeof fields.description === "string" && fields.description.trim()
        ? { description: fields.description }
        : {}),
      facts,
      ...(fallback
        ? {
            comments: latestComments(fallback),
            ...(typeof embedded?.total === "number" &&
            embedded.total > Math.min(fallback.length, COMMENT_LIMIT)
              ? { commentTotal: embedded.total }
              : {}),
          }
        : comments),
    };
  }

  /**
   * The newest comments, asked for newest first. A server that ignores the
   * order sends the oldest first; then the last page is read instead. A failure
   * is reported beside the detail, not instead of it.
   */
  private async comments(
    id: string,
    signal?: AbortSignal,
  ): Promise<Pick<WorkItemDetail, "comments" | "commentTotal" | "commentsError">> {
    try {
      const inputs = {
        issueIdOrKey: id,
        maxResults: COMMENT_LIMIT,
        responseContentFormat: "markdown",
      };
      let value = await this.client.run(
        OPERATIONS.comments,
        { ...inputs, orderBy: "-created" },
        signal,
      );
      let page = jiraComments(listOf(value, ["comments", "values"]), htmlBodies(value));
      const total = numberIn(value, "total") ?? page.length;
      const time = (comment: WorkComment | undefined) => Date.parse(comment?.created ?? "");
      if (total > page.length && page.length > 1 && time(page[0]) < time(page.at(-1))) {
        value = await this.client.run(
          OPERATIONS.comments,
          { ...inputs, orderBy: "created", startAt: Math.max(0, total - COMMENT_LIMIT) },
          signal,
        );
        page = jiraComments(listOf(value, ["comments", "values"]), htmlBodies(value));
      }
      const shown = latestComments(page);
      return { comments: shown, ...(total > shown.length ? { commentTotal: total } : {}) };
    } catch (error) {
      return { commentsError: messageOf(error) };
    }
  }

  async actions(id: string, signal?: AbortSignal): Promise<StatusAction[]> {
    const value = await this.client.run(OPERATIONS.transitions, { issueIdOrKey: id }, signal);
    const list = listOf(value, ["transitions"]);
    return (
      list as Array<{
        id?: string;
        name?: string;
        to?: { name?: string; statusCategory?: { key?: string; name?: string } };
      }>
    )
      .filter((transition) => transition.id)
      .map((transition) => ({
        id: String(transition.id),
        label: transition.name ?? `Transition ${transition.id}`,
        ...(transition.to?.name ? { to: transition.to.name } : {}),
        toCategory: categoryOf(
          transition.to?.statusCategory?.name,
          transition.to?.statusCategory?.key ?? transition.to?.name,
        ),
      }));
  }

  async apply(id: string, actionId: string, signal?: AbortSignal): Promise<void> {
    // Rovo drops parameters it doesn't recognize, so a wrong name would "succeed" without moving the issue.
    // Jira's REST shape is `transition: { id }`; v1 also took `transitionId`. Sending both is harmless.
    await this.client.run(
      OPERATIONS.transition,
      { issueIdOrKey: id, transition: { id: actionId }, transitionId: actionId },
      signal,
    );
  }

  private toItem(issue: JiraIssue, cloudId: string): WorkItem {
    const fields = issue.fields ?? {};
    const status = fields.status as
      | {
          name?: string;
          statusCategory?: { key?: string; name?: string; id?: number; colorName?: string };
        }
      | undefined;
    const site = /^https?:\/\//.test(cloudId)
      ? new URL(cloudId).origin
      : /\./.test(cloudId)
        ? `https://${cloudId}`
        : this.client.siteUrl;
    const url =
      issue.webUrl ??
      issue.url ??
      issue.self?.replace(/\/rest\/api\/.*$/, `/browse/${issue.key}`) ??
      (site ? `${site}/browse/${issue.key}` : undefined);
    return {
      source: "jira",
      id: String(issue.key),
      kind: "issue",
      title: String(fields.summary ?? issue.summary ?? issue.key),
      status: status?.name ?? String(fields.status ?? "Unknown"),
      statusCategory: categoryOf(
        status?.statusCategory?.name ?? status?.name,
        status?.statusCategory?.key,
        status?.statusCategory?.id,
        status?.statusCategory?.colorName,
      ),
      ...(url && !/\/rest\//.test(url) ? { url } : {}),
      ...((fields.project as { key?: string })?.key
        ? { container: (fields.project as { key: string }).key }
        : {}),
      ...((fields.issuetype as { name?: string })?.name
        ? { type: (fields.issuetype as { name: string }).name }
        : {}),
      ...((fields.priority as { name?: string })?.name
        ? { priority: (fields.priority as { name: string }).name }
        : {}),
      ...(typeof fields.updated === "string" ? { updated: fields.updated } : {}),
    };
  }
}

export class BitbucketSource implements WorkSource {
  readonly name = "bitbucket" as const;

  private readonly client: AtlassianClient;

  constructor(client: AtlassianClient) {
    this.client = client;
  }

  private workspace: Promise<string | undefined> | undefined;

  /**
   * The workspace to list: the configured one, else the only workspace the
   * account belongs to. With several, it asks for the workspace setting;
   * with none (no Bitbucket), it lists nothing.
   */
  workspaceId(signal?: AbortSignal): Promise<string | undefined> {
    const configured = this.client.options.bitbucketWorkspace;
    if (configured) return Promise.resolve(configured);
    this.workspace ??= this.client
      .run(OPERATIONS.workspaces, { limit: 10 }, signal)
      .then((value) => {
        const slugs = (listOf(value, ["values", "workspaces"]) as Array<{ slug?: string }>)
          .map((workspace) => workspace.slug)
          .filter((slug): slug is string => Boolean(slug));
        if (slugs.length > 1)
          throw new Error(
            `your account is in several Bitbucket workspaces (${slugs.join(", ")}); set the Bitbucket workspace in Settings → Plugins → My work`,
          );
        return slugs[0];
      })
      .catch((error) => {
        this.workspace = undefined;
        throw error;
      });
    return this.workspace;
  }

  async list(signal?: AbortSignal): Promise<SourcePage> {
    const workspaceId = await this.workspaceId(signal);
    if (!workspaceId) return { items: [] };
    const run = (operation: Operation) =>
      this.client.run(operation, { workspaceId, pagelen: LIST_LIMIT }, signal);
    const [mine, reviews] = await Promise.all([
      run(OPERATIONS.myPullRequests),
      run(OPERATIONS.myReviews),
    ]);
    const seen = new Set<string>();
    const listed = [
      ...pullRequestsOf(mine).map((pr) => toPrItem(pr, "pull-request")),
      ...pullRequestsOf(reviews).map((pr) => toPrItem(pr, "review")),
    ];
    const items = listed.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
    // Bitbucket pages carry `next` when there are more and `size`, the full count.
    const pages = [mine, reviews].map((value) => ({
      size: numberIn(value, "size"),
      count: pullRequestsOf(value).length,
      next: Boolean((value as { next?: unknown } | undefined)?.next),
    }));
    if (!pages.some((page) => page.next || (page.size ?? 0) > page.count)) return { items };
    const [mineSize, reviewSize] = pages.map((page) => page.size);
    const total =
      mineSize !== undefined && reviewSize !== undefined
        ? mineSize + reviewSize - (listed.length - items.length)
        : undefined;
    return { items, more: true, ...(total !== undefined && total > items.length ? { total } : {}) };
  }

  async detail(id: string, signal?: AbortSignal): Promise<WorkItemDetail> {
    const { workspaceId, repoId, prId } = parsePrId(id);
    const [pr, comments] = await Promise.all([
      this.client.run(
        OPERATIONS.pullRequest,
        { workspaceId, repoId, prId },
        signal,
      ) as Promise<BitbucketPr>,
      this.comments(workspaceId, repoId, prId, signal),
    ]);
    const facts: WorkItemDetail["facts"] = [];
    if (pr.author?.display_name) facts.push({ label: "Author", value: pr.author.display_name });
    if (pr.source?.branch?.name)
      facts.push({
        label: "Branch",
        value: `${pr.source.branch.name} → ${pr.destination?.branch?.name ?? "?"}`,
      });
    const reviewers = (pr.participants ?? [])
      .filter((p) => p.role === "REVIEWER")
      .map((p) => `${p.user?.display_name ?? "?"}${p.approved ? " ✓" : ""}`);
    if (reviewers.length) facts.push({ label: "Reviewers", value: reviewers.join(", ") });
    return {
      ...toPrItem(pr, "pull-request"),
      ...(pr.description ? { description: pr.description } : {}),
      facts,
      ...comments,
    };
  }

  /**
   * The newest comments. Bitbucket lists them oldest first with no sort input,
   * so a long thread is read from its last page as well.
   */
  private async comments(
    workspaceId: string,
    repoId: string,
    prId: number,
    signal?: AbortSignal,
  ): Promise<Pick<WorkItemDetail, "comments" | "commentTotal" | "commentsError">> {
    const pagelen = 100;
    try {
      const read = (page: number) =>
        this.client.run(
          OPERATIONS.pullRequestComments,
          { workspaceId, repoId, prId, pagelen, ...(page > 1 ? { page } : {}) },
          signal,
        );
      const first = await read(1);
      const size = numberIn(first, "size");
      const raw = listOf(first, ["values", "comments"]) as BitbucketComment[];
      const last = size !== undefined && size > pagelen ? Math.ceil(size / pagelen) : 1;
      if (last > 1)
        raw.push(...(listOf(await read(last), ["values", "comments"]) as BitbucketComment[]));
      const kept = raw
        .filter((comment) => !comment.deleted && !comment.pending)
        .map(bitbucketComment)
        .filter((comment): comment is WorkComment => Boolean(comment));
      // Deleted and draft comments count toward size: take out the ones read; unread pages may hold more.
      const total =
        size === undefined || size <= pagelen
          ? kept.length
          : Math.max(size - (raw.length - kept.length), kept.length);
      const shown = latestComments(kept);
      return { comments: shown, ...(total > shown.length ? { commentTotal: total } : {}) };
    } catch (error) {
      return { commentsError: messageOf(error) };
    }
  }

  async diff(id: string, signal?: AbortSignal): Promise<string> {
    const { workspaceId, repoId, prId } = parsePrId(id);
    return diffText(
      await this.client.run(OPERATIONS.pullRequestDiff, { workspaceId, repoId, prId }, signal),
    );
  }

  async actions(): Promise<StatusAction[]> {
    return [];
  }

  async apply(): Promise<void> {
    throw new Error("Bitbucket pull requests have no status changes here; open them in Bitbucket");
  }
}

function toPrItem(pr: BitbucketPr, kind: "pull-request" | "review"): WorkItem {
  // List replies leave source and destination empty; the repository is in the link then.
  const repo =
    pr.destination?.repository?.full_name ??
    pr.source?.repository?.full_name ??
    repoFromLink(pr.links?.html?.href) ??
    "repo";
  const issueKeys = issueKeysIn(pr.title, pr.source?.branch?.name);
  return {
    source: "bitbucket",
    id: `${repo}#${pr.id}`,
    kind,
    title: pr.title ?? `PR #${pr.id}`,
    status: pr.state ?? "OPEN",
    statusCategory: pr.state === "MERGED" || pr.state === "DECLINED" ? "done" : "in-progress",
    ...(pr.links?.html?.href ? { url: pr.links.html.href } : {}),
    container: repo,
    ...(pr.updated_on ? { updated: pr.updated_on } : {}),
    ...(issueKeys.length ? { issueKeys } : {}),
  };
}

/**
 * The diff text in a diff reply: `{"diff":"diff --git …"}` from Rovo v2 (once
 * its data envelope is off), or the bare text a server may send instead.
 */
export function diffText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  for (const key of ["diff", "raw", "patch", "content", "text"])
    if (typeof record[key] === "string") return record[key] as string;
  throw new Error(`the server sent no diff (${clip(JSON.stringify(value) ?? String(value), 200)})`);
}

/** `workspace/repo` from a pull request link such as https://bitbucket.org/medsky/medportal/pull-requests/296. */
export function repoFromLink(href: string | undefined): string | undefined {
  const match = href ? /bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/\d+/.exec(href) : null;
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function parsePrId(id: string): { workspaceId: string; repoId: string; prId: number } {
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(id);
  if (!match) throw new Error(`not a Bitbucket pull request id: ${id}`);
  return { workspaceId: match[1]!, repoId: match[2]!, prId: Number(match[3]) };
}

function bitbucketComment(comment: BitbucketComment): WorkComment | undefined {
  const body = comment.content?.raw?.trim() || plainText(comment.content?.html, true);
  if (!body) return undefined;
  return {
    author: comment.user?.display_name ?? comment.user?.nickname ?? "someone",
    body,
    ...(comment.created_on ? { created: comment.created_on } : {}),
    ...(comment.inline?.path ? { note: `on ${comment.inline.path}` } : {}),
  };
}

/**
 * Jira comments in the shapes Rovo sends: `author.displayName`, a markdown,
 * HTML (when `appliedContentFormat` is html) or document-format body, and an
 * optional visibility restriction or JSM internal flag, shown as a note.
 */
function jiraComments(list: unknown[], html: boolean): WorkComment[] {
  return (list as JiraComment[]).flatMap((comment) => {
    const body = plainText(comment.body ?? comment.renderedBody, html);
    if (!body) return [];
    const author =
      typeof comment.author === "string"
        ? comment.author
        : (comment.author?.displayName ?? comment.author?.display_name ?? comment.author?.name);
    const created = comment.created ?? comment.createdAt;
    const note = comment.visibility?.value
      ? `visible to ${comment.visibility.value}`
      : comment.jsdPublic === false
        ? "internal"
        : undefined;
    return [
      {
        author: author ?? "someone",
        body,
        ...(created ? { created } : {}),
        ...(note ? { note } : {}),
      },
    ];
  });
}

function htmlBodies(value: unknown): boolean {
  return (value as { appliedContentFormat?: unknown } | undefined)?.appliedContentFormat === "html";
}

/** The issue count of a search reply: `issues.totalCount` (v2 with searchResultMode), or `total`/`totalCount`. */
export function searchTotal(value: unknown): number | undefined {
  const record = value as { issues?: { totalCount?: unknown } } | undefined;
  const inner =
    record?.issues && !Array.isArray(record.issues) ? record.issues.totalCount : undefined;
  return typeof inner === "number"
    ? inner
    : (numberIn(value, "totalCount") ?? numberIn(value, "total"));
}

/** Whether a search reply says it has another page. */
export function searchHasMore(value: unknown): boolean {
  const record = value as
    | {
        isLast?: unknown;
        nextPageToken?: unknown;
        pageInfo?: { hasNextPage?: unknown };
        issues?: { pageInfo?: { hasNextPage?: unknown } };
      }
    | undefined;
  return (
    (record?.issues &&
      !Array.isArray(record.issues) &&
      record.issues.pageInfo?.hasNextPage === true) ||
    record?.pageInfo?.hasNextPage === true ||
    record?.isLast === false ||
    (typeof record?.nextPageToken === "string" && record.nextPageToken !== "")
  );
}

function numberIn(value: unknown, key: string): number | undefined {
  const found =
    value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return typeof found === "number" ? found : undefined;
}

function issuesOf(value: unknown): JiraIssue[] {
  return listOf(value, ["issues", "values"]) as JiraIssue[];
}

function pullRequestsOf(value: unknown): BitbucketPr[] {
  return listOf(value, ["values", "pullRequests"]) as BitbucketPr[];
}

/**
 * The list in a reply, in any shape the Rovo MCP sends: a bare array, an
 * array under one of `keys`, or a GraphQL-style connection (`{ nodes: [...] }`),
 * which v2 uses for search results: `{"issues":{"nodes":[...],"pageInfo":{...}}}`.
 */
export function listOf(value: unknown, keys: string[]): unknown[] {
  const nodes = (candidate: unknown): unknown[] | undefined => {
    if (Array.isArray(candidate)) return candidate;
    const inner = (candidate as { nodes?: unknown } | undefined)?.nodes;
    return Array.isArray(inner) ? inner : undefined;
  };
  const direct = nodes(value);
  if (direct) return direct;
  const record = value as Record<string, unknown> | undefined;
  for (const key of keys) {
    const found = nodes(record?.[key]);
    if (found) return found;
  }
  return [];
}

interface JiraIssue {
  key: string;
  self?: string;
  url?: string;
  webUrl?: string;
  summary?: string;
  commentCount?: number;
  fields?: Record<string, unknown>;
}

interface BitbucketPr {
  id: number;
  title?: string;
  description?: string;
  state?: string;
  updated_on?: string;
  author?: { display_name?: string };
  links?: { html?: { href?: string } };
  source?: { branch?: { name?: string }; repository?: { full_name?: string } };
  destination?: { branch?: { name?: string }; repository?: { full_name?: string } };
  participants?: Array<{ role?: string; approved?: boolean; user?: { display_name?: string } }>;
}

interface BitbucketComment {
  content?: { raw?: string; html?: string };
  user?: { display_name?: string; nickname?: string };
  created_on?: string;
  inline?: { path?: string };
  deleted?: boolean;
  pending?: boolean;
}

interface JiraComment {
  author?: string | { displayName?: string; display_name?: string; name?: string };
  body?: unknown;
  renderedBody?: string;
  created?: string;
  createdAt?: string;
  visibility?: { type?: string; value?: string };
  jsdPublic?: boolean;
}
