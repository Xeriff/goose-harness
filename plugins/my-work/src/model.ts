/** One task in the "My work" panel, whatever system it lives in. */
export interface WorkItem {
  source: "jira" | "bitbucket" | "github";
  /** Stable id within the source: Jira key, `workspace/repo#id`, or `owner/repo#number`. */
  id: string;
  kind: "issue" | "pull-request" | "review";
  title: string;
  status: string;
  /** Normalized for sorting and colour: not started, in progress, done. */
  statusCategory: "todo" | "in-progress" | "done" | "unknown";
  url?: string;
  /** Project, repository or space the item belongs to. */
  container?: string;
  type?: string;
  priority?: string;
  updated?: string;
  /** Jira keys a pull request names in its title or source branch. */
  issueKeys?: string[];
}

/** What the detail pane shows. */
export interface WorkItemDetail extends WorkItem {
  /** The branch Start work offers to create for an issue. */
  branch?: string;
  description?: string;
  /** Extra facts: assignee, reporter, branches, labels, comment count… */
  facts: Array<{ label: string; value: string }>;
  /** The latest comments, oldest first, at most COMMENT_LIMIT. */
  comments?: WorkComment[];
  /** How many comments there are in all, when that is more than `comments` holds. */
  commentTotal?: number;
  /** Why the comments could not be loaded; the rest of the detail still shows. */
  commentsError?: string;
}

export interface WorkComment {
  author: string;
  /** ISO time it was written. */
  created?: string;
  /** Plain text or markdown. */
  body: string;
  /** Where it sits or who sees it: "on src/a.ts", "visible to Developers". */
  note?: string;
}

/** The detail pane shows this many comments, the newest ones. */
export const COMMENT_LIMIT = 20;

/** The newest `limit` comments, oldest first; comments without a time keep their place. */
export function latestComments(
  comments: readonly WorkComment[],
  limit = COMMENT_LIMIT,
): WorkComment[] {
  const sorted = comments
    .map((comment, index) => ({ comment, index, at: Date.parse(comment.created ?? "") }))
    .sort((a, b) =>
      Number.isNaN(a.at) || Number.isNaN(b.at)
        ? a.index - b.index
        : a.at - b.at || a.index - b.index,
    );
  return sorted.slice(-limit).map((entry) => entry.comment);
}

/** One source's list, and whether the source has more than it returned. */
export interface SourcePage {
  items: WorkItem[];
  /** True when the source has more items than `items`. */
  more?: boolean;
  /** How many there are in all, when the source says. */
  total?: number;
}

/** Most items each source asks for; the panel says when there are more. */
export const LIST_LIMIT = 50;

/**
 * Comment or description text for display: HTML (which Rovo sends for bodies
 * with mentions or media, even when markdown was asked for) and Atlassian
 * document format become plain text; anything else is returned as it is.
 */
export function plainText(body: unknown, html = false): string {
  if (body && typeof body === "object") return adfText(body).trim();
  if (typeof body !== "string") return "";
  if (!html && !/^\s*<(p|div|span|ul|ol|h\d|table|blockquote|pre|br)\b/i.test(body))
    return body.trim();
  return body
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/(p|div|li|h\d|tr|blockquote|pre|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function adfText(node: unknown): string {
  if (Array.isArray(node)) return node.map(adfText).join("");
  if (!node || typeof node !== "object") return "";
  const record = node as {
    type?: string;
    text?: string;
    attrs?: { text?: string };
    content?: unknown[];
  };
  if (typeof record.text === "string") return record.text;
  if (record.type === "mention" || record.type === "emoji") return record.attrs?.text ?? "";
  if (record.type === "hardBreak") return "\n";
  const inner = adfText(record.content ?? []);
  return /^(paragraph|heading|listItem|codeBlock|blockquote)$/.test(record.type ?? "")
    ? `${inner}\n`
    : inner;
}

/** A status change the item can take right now. */
export interface StatusAction {
  id: string;
  label: string;
  /** Status the item lands in, when the source says. */
  to?: string;
  toCategory?: WorkItem["statusCategory"];
}

const NOT_WORK = /block|bloque|hold|wait|espera|imped|paus|parad|suspen/i;
const STARTS_WORK =
  /progress|progresso|andamento|start|in[ -]?dev|doing|working|develop|fazendo|curso/i;

/**
 * The transition Start work uses to move an issue into progress: one into an
 * "in progress" category that isn't a blocked, on-hold or waiting state,
 * preferring one that reads like starting work. None fits: don't move it.
 */
export function startWorkAction(
  actions: readonly StatusAction[] | undefined,
): StatusAction | undefined {
  const candidates = (actions ?? []).filter(
    (action) =>
      action.toCategory === "in-progress" && !NOT_WORK.test(`${action.label} ${action.to ?? ""}`),
  );
  return candidates.find((action) => STARTS_WORK.test(`${action.label} ${action.to ?? ""}`));
}

/** A source of work items; each method may throw with a readable reason. */
export interface WorkSource {
  readonly name: WorkItem["source"];
  list(signal?: AbortSignal): Promise<SourcePage>;
  detail(id: string, signal?: AbortSignal): Promise<WorkItemDetail>;
  actions(id: string, signal?: AbortSignal): Promise<StatusAction[]>;
  apply(id: string, actionId: string, signal?: AbortSignal): Promise<void>;
  /** A pull request's unified diff, for sources that have pull requests. */
  diff?(id: string, signal?: AbortSignal): Promise<string>;
}

const ISSUE_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g;
// Standards and encodings that look like keys in PR titles ("UTF-8", "SHA-256").
const NOT_A_KEY = /^(UTF|ISO|SHA|RFC|CVE|MD|AES|RSA|TLS|SSL|HTTP)-/;

/** The Jira keys named in some texts (a PR's title, its branch), in order, without repeats. */
export function issueKeysIn(...texts: Array<string | undefined>): string[] {
  const keys = texts
    .flatMap((text) => text?.match(ISSUE_KEY) ?? [])
    .filter((key) => !NOT_A_KEY.test(key));
  return [...new Set(keys)];
}

export const DEFAULT_BRANCH_PREFIX = "feature/";

/**
 * The branch Start work suggests: `feature/DEV-123-short-summary`. The key
 * stays as it is, so the branch links back to the issue (and Bitbucket and
 * Jira match it); the summary becomes a short ASCII slug.
 */
export function branchName(key: string, title: string, prefix = DEFAULT_BRANCH_PREFIX): string {
  const slug = branchSlug(title.split(key).join(" "));
  return `${prefix}${key}${slug ? `-${slug}` : ""}`;
}

const LETTERS: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
};

/** Lowercase ASCII words joined by hyphens, accents removed, cut at a word end near `max` characters. */
export function branchSlug(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[ßæœøłđðþ]/g, (letter) => LETTERS[letter]!)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= max) return slug;
  const end = slug.lastIndexOf("-", max);
  return (end > max / 2 ? slug.slice(0, end) : slug.slice(0, max)).replace(/-+$/, "");
}

export function categoryOf(
  name: string | undefined,
  key?: string,
  id?: number | string,
  colorName?: string,
): WorkItem["statusCategory"] {
  // Jira's category id and colour don't depend on the site's language: 2/blue-gray new, 4/yellow in progress, 3/green done.
  const byId: Record<string, WorkItem["statusCategory"]> = {
    2: "todo",
    4: "in-progress",
    3: "done",
    "blue-gray": "todo",
    yellow: "in-progress",
    green: "done",
  };
  if (!key && id !== undefined && byId[String(id)]) return byId[String(id)]!;
  if (!key && colorName && byId[colorName]) return byId[colorName]!;
  const value = `${key ?? ""} ${name ?? ""}`.toLowerCase();
  if (/\bdone\b|closed|resolved|merged|declined|complete/.test(value)) return "done";
  if (/indeterminate|progress|review|doing|open pr|in dev|testing|qa/.test(value))
    return "in-progress";
  if (/\bnew\b|to ?do|backlog|open|selected/.test(value)) return "todo";
  return "unknown";
}
