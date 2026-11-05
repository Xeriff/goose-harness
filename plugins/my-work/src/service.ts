import { ListCache, type SavedList } from "./list-cache.ts";
import {
  DEFAULT_BRANCH_PREFIX,
  branchName,
  type StatusAction,
  type WorkItem,
  type WorkItemDetail,
  type WorkSource,
} from "./model.ts";
import { reviewPrompt } from "./review.ts";

export interface SourceList {
  source: WorkItem["source"];
  items: WorkItem[];
  error?: string;
  /** Set when the refresh failed and `items` are the last ones that loaded, from this time (epoch ms). */
  staleSince?: number;
  /** The source has more than `items`; `total` says how many when it knows. */
  more?: boolean;
  total?: number;
}

/**
 * Combines the enabled sources for the panel. A failing source reports its
 * error beside the others instead of hiding them, and keeps the items it last
 * loaded. The last list is saved, so the panel can show it while a fresh one
 * loads.
 */
export class WorkItemsService {
  private running: Promise<SavedList> | undefined;

  private readonly sources: readonly WorkSource[];
  private readonly cache: ListCache;
  private readonly options: { branchPrefix?: string };

  constructor(
    sources: readonly WorkSource[],
    cache = new ListCache(),
    options: { branchPrefix?: string } = {},
  ) {
    this.sources = sources;
    this.cache = cache;
    this.options = options;
  }

  /** The list from the last refresh, if any. */
  saved(): SavedList | undefined {
    return this.cache.get();
  }

  /** A fresh list. Calls made while one is loading share it. */
  list(signal?: AbortSignal): Promise<SavedList> {
    this.running ??= this.load(signal).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async load(signal?: AbortSignal): Promise<SavedList> {
    const previous = this.cache.get();
    const at = Date.now();
    const sources = await Promise.all(
      this.sources.map(async (source): Promise<SourceList> => {
        try {
          const page = await source.list(signal);
          return {
            source: source.name,
            items: page.items,
            ...(page.more ? { more: true } : {}),
            ...(page.more && page.total !== undefined ? { total: page.total } : {}),
          };
        } catch (error) {
          const last = previous?.sources.find(
            (list) => list.source === source.name && list.items.length > 0,
          );
          return last
            ? {
                ...last,
                source: source.name,
                error: message(error),
                staleSince: last.staleSince ?? previous!.at,
              }
            : { source: source.name, items: [], error: message(error) };
        }
      }),
    );
    const fresh = { sources, at };
    this.cache.set(fresh);
    return fresh;
  }

  /** An item's detail; an issue also gets the branch Start work offers to create. */
  async detail(source: string, id: string, signal?: AbortSignal): Promise<WorkItemDetail> {
    const detail = await this.source(source).detail(id, signal);
    if (detail.kind !== "issue") return detail;
    // A GitHub issue has no key of its own; its number names the branch instead.
    const key = detail.source === "github" ? id.replace(/^.*#/, "") : id;
    return {
      ...detail,
      branch: branchName(key, detail.title, this.options.branchPrefix ?? DEFAULT_BRANCH_PREFIX),
    };
  }

  /**
   * The first message of a review chat for a pull request. A diff that can't
   * be read is said in the message, which still carries the rest.
   */
  async reviewPrompt(source: string, id: string, signal?: AbortSignal): Promise<string> {
    const found = this.source(source);
    if (!found.diff) throw new Error(`${source} has no pull requests to review`);
    const [detail, diff] = await Promise.all([
      found.detail(id, signal),
      found.diff(id, signal).then(
        (text) => ({ text }),
        (error: unknown) => ({ error: message(error) }),
      ),
    ]);
    if (detail.kind === "issue") throw new Error(`${id} is an issue, not a pull request`);
    return reviewPrompt(detail, diff);
  }

  actions(source: string, id: string, signal?: AbortSignal): Promise<StatusAction[]> {
    return this.source(source).actions(id, signal);
  }

  apply(source: string, id: string, actionId: string, signal?: AbortSignal): Promise<void> {
    return this.source(source).apply(id, actionId, signal);
  }

  private source(name: string): WorkSource {
    const found = this.sources.find((source) => source.name === name);
    if (!found) throw new Error(`source "${name}" is not enabled`);
    return found;
  }
}

/**
 * The first message of a Start work thread, which the user can edit before sending.
 * With `branch`, the agent is asked to create that branch first: the plugin never
 * runs git itself, so the agent does it under the thread's own approvals.
 */
export function startPrompt(item: WorkItemDetail, { branch }: { branch?: string } = {}): string {
  const what =
    item.source === "jira"
      ? `Jira issue ${item.id}`
      : item.source === "bitbucket"
        ? `Bitbucket pull request ${item.id}`
        : `GitHub ${item.kind === "issue" ? "issue" : "pull request"} ${item.id}`;
  const lines = [
    item.kind === "review"
      ? `I want to review ${what}: "${item.title}".`
      : `I want to start work on ${what}: "${item.title}".`,
    "",
    `- Status: ${item.status}${item.type ? ` · Type: ${item.type}` : ""}${item.priority ? ` · Priority: ${item.priority}` : ""}`,
    ...(item.container
      ? [`- ${item.source === "jira" ? "Project" : "Repository"}: ${item.container}`]
      : []),
    ...item.facts.map((fact) => `- ${fact.label}: ${fact.value}`),
    ...(item.issueKeys?.length ? [`- Linked issues: ${item.issueKeys.join(", ")}`] : []),
    ...(item.url ? [`- Link: ${item.url}`] : []),
  ];
  if (item.description?.trim())
    lines.push("", "Description:", "", clip(item.description.trim(), 6000));
  lines.push(
    "",
    item.source === "github"
      ? "Use the gh CLI if you need more context (comments, linked PRs)."
      : "If you need more context (comments, linked issues, the PR diff), use the Atlassian MCP tools available to you.",
  );
  if (branch && item.kind === "issue") {
    lines.push(
      `First, create the branch \`${branch}\` from the up-to-date default branch (fetch it from the remote first) and switch to it. If that branch already exists, switch to it instead.`,
      "Then explore the relevant code and propose a short plan before changing anything.",
    );
  } else {
    lines.push(
      item.kind === "review"
        ? "Start by reading the changes and summarizing what the PR does, then list concerns before suggesting fixes."
        : "Start by exploring the relevant code and propose a short plan before changing anything.",
    );
  }
  return lines.join("\n");
}

function clip(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}\n\n[description shortened; see the link for the rest]`
    : text;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
