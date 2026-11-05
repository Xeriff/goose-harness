import type { WorkItemDetail } from "./model.ts";

/** About how much diff a review message carries; whole files are kept up to it. */
export const DIFF_BUDGET = 60_000;

/** One file's part of a unified diff. */
export interface DiffFile {
  path: string;
  /** Its section of the diff, from its `diff --git` line. */
  text: string;
  additions: number;
  deletions: number;
}

/** A diff cut down to fit a message, and what it leaves out. */
export interface TrimmedDiff {
  text: string;
  /** How many files the whole diff touches. */
  files: number;
  /** Files left out entirely. */
  omitted: Array<Omit<DiffFile, "text"> & { chars: number }>;
  /** A file shown only in part, when no whole file fit. */
  partial?: string;
}

/** Splits a git diff into its files; a diff without `diff --git` lines is one file. */
export function diffFiles(diff: string): DiffFile[] {
  const starts = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index);
  if (!starts.length) return diff.trim() ? [fileOf(diff)] : [];
  return starts.map((start, index) =>
    fileOf(diff.slice(index === 0 ? 0 : start, starts[index + 1] ?? diff.length)),
  );
}

function fileOf(text: string): DiffFile {
  const lines = text.split("\n");
  const hunk = lines.findIndex((line) => line.startsWith("@@"));
  // Only the header names the file: a changed line can start with "+++" too.
  const header = (hunk === -1 ? lines : lines.slice(0, hunk)).join("\n");
  let additions = 0;
  let deletions = 0;
  if (hunk !== -1) {
    for (const line of lines.slice(hunk)) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
  }
  return { path: pathOf(header) ?? "(unnamed file)", text, additions, deletions };
}

function pathOf(header: string): string | undefined {
  const clean = (path: string) =>
    path
      .replace(/\t.*$/, "")
      .replace(/^"(.*)"$/, "$1")
      .replace(/^[ab]\//, "");
  const after = /^\+\+\+ (.+)$/m.exec(header)?.[1];
  if (after && after !== "/dev/null") return clean(after);
  const before = /^--- (.+)$/m.exec(header)?.[1];
  if (before && before !== "/dev/null") return clean(before);
  const renamed = /^rename to (.+)$/m.exec(header)?.[1];
  if (renamed) return renamed;
  // `diff --git a/x b/x`: the two halves are the same path, which may hold spaces.
  const both = /^diff --git (.+)$/m.exec(header)?.[1];
  if (both && both.length % 2 === 1) {
    const half = (both.length - 1) / 2;
    if (both.slice(0, half).replace(/^a\//, "") === both.slice(half + 1).replace(/^b\//, ""))
      return clean(both.slice(0, half));
  }
  return both;
}

/** Lockfiles, bundles, maps, snapshots and vendored code: they make way for everything else. */
const GENERATED =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.min\.(js|css)$|\.map$|\.snap$|(^|\/)(dist|vendor|generated|__generated__)\//;
/** Prose: reviewed after the code, which is where most findings are. */
const DOCS = /\.(md|mdx|rst|txt|adoc)$|(^|\/)docs?\//i;

function rank(path: string): number {
  return GENERATED.test(path) ? 2 : DOCS.test(path) ? 1 : 0;
}

/**
 * Keeps whole files while they fit in `budget` characters, code first, then
 * docs, then generated files, and lists the rest with their sizes. A file is
 * never cut midway, except when not even one fits: then the first one is
 * shown up to the budget.
 */
export function trimDiff(diff: string, budget = DIFF_BUDGET): TrimmedDiff {
  const files = diffFiles(diff);
  if (diff.length <= budget) return { text: diff, files: files.length, omitted: [] };
  const order = files
    .map((file, index) => ({ file, index }))
    .sort((a, b) => rank(a.file.path) - rank(b.file.path) || a.index - b.index);
  const kept = new Set<number>();
  let left = budget;
  for (const { file, index } of order) {
    if (file.text.length <= left) {
      kept.add(index);
      left -= file.text.length;
    }
  }
  let partial: { index: number; text: string } | undefined;
  if (!kept.size && order[0]) {
    const { file, index } = order[0];
    const cut = file.text.lastIndexOf("\n", budget);
    partial = { index, text: file.text.slice(0, cut > 0 ? cut + 1 : budget) };
  }
  return {
    text: files
      .map((file, index) =>
        kept.has(index) ? file.text : partial?.index === index ? partial.text : "",
      )
      .join(""),
    files: files.length,
    omitted: files
      .filter((_, index) => !kept.has(index) && partial?.index !== index)
      .map((file) => ({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        chars: file.text.length,
      })),
    ...(partial ? { partial: files[partial.index]!.path } : {}),
  };
}

/**
 * The first message of a "Review in a chat" session: the pull request, its
 * comments and its diff (trimmed to fit), with what a review should report.
 * The diff is either its text or why it could not be read.
 */
export function reviewPrompt(
  item: WorkItemDetail,
  diff: { text: string } | { error: string },
  budget = DIFF_BUDGET,
): string {
  const what = `${item.source === "bitbucket" ? "Bitbucket" : "GitHub"} pull request ${item.id}`;
  const lines = [
    `Please review ${what}: "${item.title}".`,
    "",
    `- Status: ${item.status}`,
    ...(item.container ? [`- Repository: ${item.container}`] : []),
    ...item.facts
      .filter((fact) => fact.label !== "Comments")
      .map((fact) => `- ${fact.label}: ${fact.value}`),
    ...(item.issueKeys?.length ? [`- Linked issues: ${item.issueKeys.join(", ")}`] : []),
    ...(item.url ? [`- Link: ${item.url}`] : []),
  ];
  if (item.description?.trim())
    lines.push(
      "",
      "Description:",
      "",
      clip(item.description.trim(), 6000, "[description shortened; see the link for the rest]"),
    );

  const comments = item.comments ?? [];
  if (comments.length) {
    const total =
      item.commentTotal !== undefined && item.commentTotal > comments.length
        ? `the latest ${comments.length} of ${item.commentTotal}`
        : String(comments.length);
    lines.push("", `Comments (${total}, oldest first):`);
    for (const comment of comments) {
      const about = [comment.created?.slice(0, 10), comment.note].filter(Boolean).join(", ");
      lines.push(
        "",
        `${comment.author}${about ? ` (${about})` : ""}:`,
        ...clip(comment.body, 2000, "[comment shortened]")
          .split("\n")
          .map((line) => `> ${line}`),
      );
    }
  } else if (item.commentsError) {
    lines.push("", `(The comments could not be loaded: ${item.commentsError})`);
  }

  if ("error" in diff) {
    lines.push(
      "",
      `The diff could not be loaded (${diff.error}). Read the changes from the link or with the tools available to you.`,
    );
  } else if (!diff.text.trim()) {
    lines.push("", "The diff is empty.");
  } else {
    const trimmed = trimDiff(diff.text, budget);
    const shown = trimmed.files - trimmed.omitted.length;
    lines.push(
      "",
      trimmed.omitted.length || trimmed.partial
        ? `Diff, trimmed to fit this message: ${trimmed.partial ? `the start of ${trimmed.partial}` : `${shown} of ${trimmed.files} files`}, about ${formatNumber(trimmed.text.length)} of ${formatNumber(diff.text.length)} characters:`
        : `Diff (${trimmed.files} ${trimmed.files === 1 ? "file" : "files"}):`,
    );
    // A fence longer than any run of backticks in the diff, so markdown files in it can't close it.
    const fence = "`".repeat(
      Math.max(3, ...(trimmed.text.match(/`+/g) ?? []).map((run) => run.length + 1)),
    );
    lines.push("", `${fence}diff`, trimmed.text.replace(/\n$/, ""), fence);
    if (trimmed.omitted.length) {
      lines.push(
        "",
        "Left out of the diff above (read them from the repository or the link if they matter):",
      );
      for (const file of trimmed.omitted)
        lines.push(
          `- ${file.path} (+${file.additions} −${file.deletions}, ${formatNumber(file.chars)} characters)`,
        );
    }
  }

  lines.push(
    "",
    "Review these changes:",
    "- Start with a short summary of what the pull request does.",
    "- Then list your findings grouped by severity (critical, major, minor, nit). For each, give the file and line (on the new side of the diff), what is wrong, and a suggested fix.",
    "- End with anything you could not judge from the diff alone.",
    "- Keep the review in this chat: do not comment on, approve, decline or merge the pull request.",
  );
  return lines.join("\n");
}

function clip(text: string, max: number, note: string): string {
  return text.length > max ? `${text.slice(0, max)}\n\n${note}` : text;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}
