import * as NodeChildProcess from "node:child_process";
import {
  COMMENT_LIMIT,
  LIST_LIMIT,
  issueKeysIn,
  latestComments,
  type SourcePage,
  type StatusAction,
  type WorkItem,
  type WorkItemDetail,
  type WorkSource,
} from "./model.ts";

/** Runs the user's own `gh` CLI (their GitHub login); arguments are passed as data, never through a shell. */
export type Gh = (args: string[], signal?: AbortSignal) => Promise<string>;

export const GH_TIMEOUT_MS = 20_000;

/**
 * A `gh` runner that gives up after `timeoutMs`. A hung gh (a login prompt, a
 * stalled network) would otherwise hold the shared refresh forever; on timeout
 * the process is killed and the call fails at once, without waiting for its
 * pipes to close, so only the GitHub source shows the error.
 */
export function ghRunner({
  command = "gh",
  timeoutMs = GH_TIMEOUT_MS,
}: { command?: string; timeoutMs?: number } = {}): Gh {
  return (args, signal) =>
    new Promise((resolve, reject) => {
      let timedOut = false;
      const child = NodeChildProcess.execFile(
        command,
        args,
        { windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...(signal ? { signal } : {}) },
        (error, stdout, stderr) => {
          clearTimeout(timer);
          if (timedOut) return;
          if (!error) return resolve(stdout);
          const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
          reject(
            new Error(
              missing
                ? "the GitHub CLI (gh) is not installed or not on PATH"
                : stderr.trim() || error.message,
            ),
          );
        },
      );
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        reject(
          new Error(
            `gh ${args.slice(0, 2).join(" ")} did not answer within ${timeoutMs / 1000} s. Check that \`gh auth status\` works in a terminal.`,
          ),
        );
      }, timeoutMs);
    });
}

export const runGh: Gh = ghRunner();

const SEARCH_FIELDS = "number,title,repository,url,updatedAt,state,labels";

/** Open GitHub issues assigned to you, your open PRs, and PRs awaiting your review, through `gh`. */
export class GitHubSource implements WorkSource {
  readonly name = "github" as const;

  private readonly gh: Gh;

  constructor(gh: Gh = runGh) {
    this.gh = gh;
  }

  async list(signal?: AbortSignal): Promise<SourcePage> {
    let more = false;
    const search = async (kind: "issues" | "prs", filter: string, as: WorkItem["kind"]) => {
      // gh search gives no total, so ask for one more than is shown: getting it means there are more.
      const out = await this.gh(
        [
          "search",
          kind,
          filter,
          "--state=open",
          "--limit",
          String(LIST_LIMIT + 1),
          "--json",
          SEARCH_FIELDS,
        ],
        signal,
      );
      const hits = JSON.parse(out || "[]") as SearchHit[];
      if (hits.length > LIST_LIMIT) more = true;
      return hits.slice(0, LIST_LIMIT).map((hit) => toItem(hit, as));
    };
    const [issues, mine, reviews] = await Promise.all([
      search("issues", "--assignee=@me", "issue"),
      search("prs", "--author=@me", "pull-request"),
      search("prs", "--review-requested=@me", "review"),
    ]);
    const seen = new Set<string>();
    const items = [...issues, ...mine, ...reviews].filter((item) =>
      seen.has(item.id) ? false : (seen.add(item.id), true),
    );
    return { items, ...(more ? { more } : {}) };
  }

  async detail(id: string, signal?: AbortSignal): Promise<WorkItemDetail> {
    const { repo, number } = parseId(id);
    // `gh issue view` also reads pull requests; ask for fields both share.
    const out = await this.gh(
      [
        "issue",
        "view",
        String(number),
        "-R",
        repo,
        "--json",
        "number,title,body,state,url,labels,assignees,author,comments,updatedAt",
      ],
      signal,
    );
    const issue = JSON.parse(out) as SearchHit & {
      body?: string;
      assignees?: Array<{ login: string }>;
      author?: { login?: string };
      comments?: GhComment[];
    };
    const pull = /\/pull\//.test(issue.url ?? "");
    // Only `gh pr view` knows a pull request's branches; without them the detail still shows.
    const branches = pull
      ? await this.gh(
          ["pr", "view", String(number), "-R", repo, "--json", "headRefName,baseRefName"],
          signal,
        ).then(
          (out) => JSON.parse(out) as { headRefName?: string; baseRefName?: string },
          () => undefined,
        )
      : undefined;
    const facts: WorkItemDetail["facts"] = [];
    if (issue.author?.login) facts.push({ label: "Author", value: issue.author.login });
    if (branches?.headRefName)
      facts.push({
        label: "Branch",
        value: `${branches.headRefName} → ${branches.baseRefName ?? "?"}`,
      });
    if (issue.assignees?.length)
      facts.push({ label: "Assignees", value: issue.assignees.map((a) => a.login).join(", ") });
    if (issue.labels?.length)
      facts.push({ label: "Labels", value: issue.labels.map((l) => l.name).join(", ") });
    if (Array.isArray(issue.comments))
      facts.push({ label: "Comments", value: String(issue.comments.length) });
    // The conversation comments; a pull request's review comments on code are not in this list.
    const all = (Array.isArray(issue.comments) ? issue.comments : [])
      .filter((comment) => comment.body?.trim())
      .map((comment) => ({
        author: comment.author?.login ?? "someone",
        body: comment.body!.trim(),
        ...(comment.createdAt ? { created: comment.createdAt } : {}),
      }));
    const issueKeys = pull ? issueKeysIn(issue.title, branches?.headRefName) : [];
    return {
      ...toItem({ ...issue, repository: { nameWithOwner: repo } }, pull ? "pull-request" : "issue"),
      ...(issueKeys.length ? { issueKeys } : {}),
      ...(issue.body ? { description: issue.body } : {}),
      facts,
      comments: latestComments(all),
      ...(all.length > COMMENT_LIMIT ? { commentTotal: all.length } : {}),
    };
  }

  async diff(id: string, signal?: AbortSignal): Promise<string> {
    const { repo, number } = parseId(id);
    return this.gh(["pr", "diff", String(number), "-R", repo, "--color=never"], signal);
  }

  async actions(id: string, signal?: AbortSignal): Promise<StatusAction[]> {
    const detail = await this.detail(id, signal);
    if (detail.kind !== "issue") return [];
    return detail.statusCategory === "done"
      ? [{ id: "reopen", label: "Reopen", to: "OPEN", toCategory: "todo" }]
      : [{ id: "close", label: "Close", to: "CLOSED", toCategory: "done" }];
  }

  async apply(id: string, actionId: string, signal?: AbortSignal): Promise<void> {
    if (actionId !== "close" && actionId !== "reopen")
      throw new Error(`unknown GitHub action ${actionId}`);
    const { repo, number } = parseId(id);
    await this.gh(["issue", actionId, String(number), "-R", repo], signal);
  }
}

function toItem(hit: SearchHit, kind: WorkItem["kind"]): WorkItem {
  const repo = hit.repository?.nameWithOwner ?? "repo";
  const state = String(hit.state ?? "open").toUpperCase();
  const issueKeys = kind === "issue" ? [] : issueKeysIn(hit.title);
  return {
    source: "github",
    id: `${repo}#${hit.number}`,
    kind,
    title: hit.title ?? `#${hit.number}`,
    status: state,
    statusCategory:
      state === "CLOSED" || state === "MERGED" ? "done" : kind === "issue" ? "todo" : "in-progress",
    ...(hit.url ? { url: hit.url } : {}),
    container: repo,
    ...(hit.updatedAt ? { updated: hit.updatedAt } : {}),
    ...(issueKeys.length ? { issueKeys } : {}),
  };
}

function parseId(id: string): { repo: string; number: number } {
  const match = /^([^/#]+\/[^#]+)#(\d+)$/.exec(id);
  if (!match) throw new Error(`not a GitHub item id: ${id}`);
  return { repo: match[1]!, number: Number(match[2]) };
}

interface SearchHit {
  number: number;
  title?: string;
  url?: string;
  state?: string;
  updatedAt?: string;
  labels?: Array<{ name: string }>;
  repository?: { nameWithOwner?: string };
}

interface GhComment {
  author?: { login?: string };
  body?: string;
  createdAt?: string;
}
