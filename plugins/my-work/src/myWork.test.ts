import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { GooseHttpRequest, GooseHttpResponse, JsonValue } from "@t3tools/goose-plugin-api";
import { test } from "vite-plus/test";
import {
  AtlassianClient,
  BitbucketSource,
  DEFAULT_JQL,
  JiraSource,
  diffText,
  listOf,
  repoFromLink,
  resultValue,
  unwrapData,
  type McpAdmin,
} from "./atlassian.ts";
import {
  branchName,
  branchSlug,
  categoryOf,
  issueKeysIn,
  latestComments,
  plainText,
  startWorkAction,
} from "./model.ts";
import { GitHubSource, ghRunner } from "./github.ts";
import { ListCache } from "./list-cache.ts";
import { diffFiles, reviewPrompt, trimDiff } from "./review.ts";
import server from "./server.ts";
import { WorkItemsService, startPrompt } from "./service.ts";

/** A fake MCP admin: records tool calls and answers from a script. */
function fakeAdmin(
  answers: Record<string, (args: Record<string, unknown>) => unknown>,
  servers = ["atlassian"],
  options: { tools?: string[]; url?: string } = {},
) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const admin: McpAdmin = {
    servers: () =>
      servers.map((name) => ({
        name,
        enabled: true,
        ...(options.url ? { url: options.url } : {}),
      })),
    ...(options.tools ? { listTools: async () => options.tools!.map((name) => ({ name })) } : {}),
    async callTool(_server, tool, args = {}) {
      calls.push([tool, args]);
      const key = /^execute/.test(tool) ? `${tool}:${args.name}` : tool;
      const answer = answers[key];
      if (!answer)
        return { isError: true, content: [{ type: "text", text: `no such tool ${key}` }] };
      return { isError: false, content: [{ type: "text", text: JSON.stringify(answer(args)) }] };
    },
  };
  return { admin, calls };
}

const ISSUE = {
  key: "PAY-42",
  self: "https://acme.atlassian.net/rest/api/3/issue/10042",
  fields: {
    summary: "Fix rounding in invoice totals",
    status: { name: "To Do", statusCategory: { key: "new", name: "To Do" } },
    priority: { name: "High" },
    issuetype: { name: "Bug" },
    project: { key: "PAY" },
    updated: "2026-11-01T10:00:00.000+0000",
  },
};

test("lists Jira issues through the Atlassian MCP, choosing the first site", async () => {
  const { admin, calls } = fakeAdmin({
    getAccessibleAtlassianResources: () => [{ id: "cloud-1", url: "https://acme.atlassian.net" }],
    searchJiraIssuesUsingJql: () => ({ issues: [ISSUE], isLast: true }),
  });
  const jira = new JiraSource(
    new AtlassianClient(() => admin, { server: "atlassian", jql: DEFAULT_JQL }),
  );
  const {
    items: [item],
  } = await jira.list();
  NodeAssert.deepEqual(item, {
    source: "jira",
    id: "PAY-42",
    kind: "issue",
    title: "Fix rounding in invoice totals",
    status: "To Do",
    statusCategory: "todo",
    url: "https://acme.atlassian.net/browse/PAY-42",
    container: "PAY",
    type: "Bug",
    priority: "High",
    updated: "2026-11-01T10:00:00.000+0000",
  });
  NodeAssert.equal(calls[1]?.[1].cloudId, "cloud-1");
  NodeAssert.equal(calls[1]?.[1].jql, DEFAULT_JQL);
  await jira.list();
  NodeAssert.equal(
    calls.filter(([tool]) => tool === "getAccessibleAtlassianResources").length,
    1,
    "the site is looked up once",
  );
});

test("Jira detail, transitions and status change", async () => {
  const { admin, calls } = fakeAdmin({
    getJiraIssue: () => ({
      ...ISSUE,
      fields: {
        ...ISSUE.fields,
        description: "Totals are off by one cent.",
        assignee: { displayName: "Dee" },
        labels: ["billing"],
        comment: { total: 3 },
      },
    }),
    "executeRead:getTransitionsForJiraIssue": () => ({
      transitions: [
        {
          id: "21",
          name: "Start progress",
          to: {
            name: "In Progress",
            statusCategory: { key: "indeterminate", name: "In Progress" },
          },
        },
        {
          id: "31",
          name: "Done",
          to: { name: "Done", statusCategory: { key: "done", name: "Done" } },
        },
      ],
    }),
    transitionJiraIssue: () => ({ status: "In Progress" }),
  });
  const jira = new JiraSource(
    new AtlassianClient(() => admin, {
      server: "atlassian",
      site: "acme.atlassian.net",
      jql: DEFAULT_JQL,
    }),
  );
  const detail = await jira.detail("PAY-42");
  NodeAssert.equal(detail.description, "Totals are off by one cent.");
  NodeAssert.deepEqual(detail.facts, [
    { label: "Assignee", value: "Dee" },
    { label: "Labels", value: "billing" },
    { label: "Comments", value: "3" },
  ]);
  NodeAssert.deepEqual(
    (await jira.actions("PAY-42")).map((a) => [a.id, a.to, a.toCategory]),
    [
      ["21", "In Progress", "in-progress"],
      ["31", "Done", "done"],
    ],
  );
  await jira.apply("PAY-42", "21");
  NodeAssert.deepEqual(calls.at(-1), [
    "transitionJiraIssue",
    {
      cloudId: "acme.atlassian.net",
      issueIdOrKey: "PAY-42",
      transition: { id: "21" },
      transitionId: "21",
    },
  ]);
});

test("explains a missing Atlassian server instead of failing silently", async () => {
  const none = new JiraSource(
    new AtlassianClient(() => undefined, { server: "atlassian", jql: DEFAULT_JQL }),
  );
  await NodeAssert.rejects(none.list(), /no MCP server named "atlassian"/);
  const { admin } = fakeAdmin({}, ["github"]);
  const wrong = new JiraSource(
    new AtlassianClient(() => admin, { server: "atlassian", jql: DEFAULT_JQL }),
  );
  await NodeAssert.rejects(wrong.list(), /no MCP server named "atlassian"/);
});

test("v2: primary tools are called directly, the rest through execute with cloudId at the top level", async () => {
  const { admin, calls } = fakeAdmin(
    {
      getAccessibleAtlassianResources: () => [{ id: "cloud-1" }],
      "execute:getTransitionsForJiraIssue": () => ({ transitions: [{ id: "21", name: "Start" }] }),
      "execute:transitionJiraIssue": () => ({}),
    },
    ["atlassian"],
    {
      tools: [
        "getAccessibleAtlassianResources",
        "searchJiraIssuesUsingJql",
        "getJiraIssue",
        "execute",
        "discover",
      ],
    },
  );
  const jira = new JiraSource(
    new AtlassianClient(() => admin, { server: "atlassian", jql: DEFAULT_JQL }),
  );
  NodeAssert.deepEqual(
    (await jira.actions("PAY-42")).map((a) => a.id),
    ["21"],
  );
  NodeAssert.deepEqual(calls.at(-1), [
    "execute",
    { name: "getTransitionsForJiraIssue", cloudId: "cloud-1", inputs: { issueIdOrKey: "PAY-42" } },
  ]);
  await jira.apply("PAY-42", "21");
  NodeAssert.equal(
    calls.at(-1)?.[0],
    "execute",
    "transitionJiraIssue is not primary here, so it goes through execute",
  );
});

test("an operation the server does not know is looked up with discover", async () => {
  const { admin, calls } = fakeAdmin(
    {
      discover: () => ({
        results: [{ name: "getJiraIssueTransitionsV2", inputs: { issueIdOrKey: "string" } }],
      }),
      "executeRead:getJiraIssueTransitionsV2": () => [{ id: "5", name: "Close" }],
    },
    ["atlassian"],
    { tools: ["executeRead", "executeWrite", "discover"] },
  );
  const jira = new JiraSource(
    new AtlassianClient(() => admin, {
      server: "atlassian",
      site: "acme.atlassian.net",
      jql: DEFAULT_JQL,
    }),
  );
  NodeAssert.deepEqual(
    (await jira.actions("PAY-1")).map((a) => a.label),
    ["Close"],
  );
  await jira.actions("PAY-2");
  NodeAssert.equal(
    calls.filter(([tool]) => tool === "discover").length,
    1,
    "the discovered name is remembered",
  );
});

test("v1 endpoints get a message to switch to v2", async () => {
  const { admin } = fakeAdmin({}, ["atlassian"], {
    tools: ["getJiraIssue", "searchJiraIssuesUsingJql"],
    url: "https://mcp.atlassian.com/v1/mcp",
  });
  const jira = new JiraSource(
    new AtlassianClient(() => admin, {
      server: "atlassian",
      site: "acme.atlassian.net",
      jql: DEFAULT_JQL,
    }),
  );
  await NodeAssert.rejects(
    jira.actions("PAY-1"),
    /older v1 endpoint.*Switch to Atlassian v2.*https:\/\/mcp\.atlassian\.com\/v2\/mcp/,
  );
});

test("results are read from structured content, or from JSON inside text", () => {
  NodeAssert.deepEqual(
    resultValue({
      isError: false,
      content: [{ type: "text", text: "ignored" }],
      structuredContent: { a: 1 },
    }),
    { a: 1 },
  );
  NodeAssert.deepEqual(
    resultValue({
      isError: false,
      content: [
        { type: "text", text: '[{"id":"c"}]' },
        { type: "text", text: "Tip: pass cloudId next time." },
      ],
    }),
    [{ id: "c" }],
  );
  NodeAssert.deepEqual(
    resultValue({
      isError: false,
      content: [{ type: "text", text: 'Sites:\n```json\n{"id":"c"}\n```' }],
    }),
    { id: "c" },
  );
  NodeAssert.equal(
    resultValue({ isError: false, content: [{ type: "text", text: "plain" }] }),
    "plain",
  );
});

test("lists my Bitbucket PRs and review requests, deduplicated", async () => {
  const pr = {
    id: 7,
    title: "Add retries",
    state: "OPEN",
    destination: { repository: { full_name: "acme/payments" } },
    links: { html: { href: "https://bitbucket.org/acme/payments/pull-requests/7" } },
  };
  const { admin, calls } = fakeAdmin({
    "executeRead:listMyBitbucketPullRequests": () => ({ values: [pr] }),
    "executeRead:listMyBitbucketReviewRequests": () => ({
      values: [pr, { ...pr, id: 9, title: "Bump deps" }],
    }),
  });
  const bitbucket = new BitbucketSource(
    new AtlassianClient(() => admin, {
      server: "atlassian",
      site: "cloud-1",
      jql: DEFAULT_JQL,
      bitbucketWorkspace: "acme",
    }),
  );
  NodeAssert.deepEqual(
    (await bitbucket.list()).items.map((i) => [i.id, i.kind]),
    [
      ["acme/payments#7", "pull-request"],
      ["acme/payments#9", "review"],
    ],
  );
  NodeAssert.equal(
    calls.at(-1)?.[1].cloudId,
    "cloud-1",
    "execute calls carry cloudId at the top level",
  );
});

test("GitHub through gh: list, detail, close", async () => {
  const runs: string[][] = [];
  const github = new GitHubSource(async (args) => {
    runs.push(args);
    if (args[0] === "search" && args[1] === "issues")
      return JSON.stringify([
        {
          number: 5,
          title: "Docs typo",
          state: "open",
          url: "https://github.com/me/site/issues/5",
          repository: { nameWithOwner: "me/site" },
        },
      ]);
    if (args[0] === "search") return "[]";
    if (args[0] === "issue" && args[1] === "view")
      return JSON.stringify({
        number: 5,
        title: "Docs typo",
        state: "OPEN",
        url: "https://github.com/me/site/issues/5",
        body: "Fix it",
        labels: [{ name: "docs" }],
        comments: [],
      });
    return "";
  });
  NodeAssert.deepEqual(
    (await github.list()).items.map((i) => i.id),
    ["me/site#5"],
  );
  NodeAssert.deepEqual(runs[0], [
    "search",
    "issues",
    "--assignee=@me",
    "--state=open",
    "--limit",
    "51",
    "--json",
    "number,title,repository,url,updatedAt,state,labels",
  ]);
  NodeAssert.deepEqual(
    (await github.actions("me/site#5")).map((a) => a.id),
    ["close"],
  );
  await github.apply("me/site#5", "close");
  NodeAssert.deepEqual(runs.at(-1), ["issue", "close", "5", "-R", "me/site"]);
  await NodeAssert.rejects(github.apply("me/site#5", "delete"), /unknown GitHub action/);
});

test("a failing source does not hide the others; the start prompt carries the context", async () => {
  const broken = {
    name: "jira" as const,
    list: async () => {
      throw new Error("signed out");
    },
    detail: async () => {
      throw new Error("x");
    },
    actions: async () => [],
    apply: async () => {},
  };
  const github = new GitHubSource(async (args) =>
    args[1] === "issues"
      ? JSON.stringify([
          { number: 1, title: "T", state: "open", repository: { nameWithOwner: "a/b" } },
        ])
      : "[]",
  );
  const { sources: lists } = await new WorkItemsService([broken, github]).list();
  NodeAssert.deepEqual(
    lists.map((l) => [l.source, l.items.length, l.error]),
    [
      ["jira", 0, "signed out"],
      ["github", 1, undefined],
    ],
  );

  const prompt = startPrompt({
    source: "jira",
    id: "PAY-42",
    kind: "issue",
    title: "Fix rounding",
    status: "To Do",
    statusCategory: "todo",
    type: "Bug",
    container: "PAY",
    url: "https://acme.atlassian.net/browse/PAY-42",
    description: "Off by one cent.",
    facts: [{ label: "Assignee", value: "Dee" }],
  });
  NodeAssert.match(prompt, /^I want to start work on Jira issue PAY-42: "Fix rounding"\./);
  NodeAssert.match(prompt, /- Project: PAY/);
  NodeAssert.match(prompt, /Description:\n\nOff by one cent\./);
  NodeAssert.match(prompt, /propose a short plan before changing anything/);
});

test("diagnose reports each step and stops at the first one that cannot continue", async () => {
  const { admin } = fakeAdmin(
    {
      getAccessibleAtlassianResources: () => [{ id: "cloud-1" }],
      searchJiraIssuesUsingJql: () => ({ issues: [ISSUE] }),
    },
    ["atlassian"],
    {
      tools: ["getAccessibleAtlassianResources", "searchJiraIssuesUsingJql", "executeRead"],
      url: "https://mcp.atlassian.com/v2/mcp",
    },
  );
  const report = await new AtlassianClient(() => admin, {
    server: "atlassian",
    jql: DEFAULT_JQL,
  }).diagnose();
  NodeAssert.match(
    report,
    /✓ MCP server \(\d+\.\d s\): "atlassian" at https:\/\/mcp\.atlassian\.com\/v2\/mcp\n✓ Tools \(\d+\.\d s\): 3: .*\n✓ Site \(\d+\.\d s\): cloud-1\n✓ Jira search \(\d+\.\d s\): OK, first result PAY-42\n✓ Full list \(\d+\.\d s\): 1 issues/,
  );
  const missing = await new AtlassianClient(() => undefined, {
    server: "atlassian",
    jql: DEFAULT_JQL,
  }).diagnose();
  NodeAssert.match(missing, /^✗ MCP server \(\d+\.\d s\): no MCP server named/);
});

test("v2 replies wrapped in a data envelope: the site and issues are found", async () => {
  // The exact shape Rovo MCP v2 returns for getAccessibleAtlassianResources.
  const { admin, calls } = fakeAdmin({
    getAccessibleAtlassianResources: () => ({
      data: {
        resources: [
          {
            cloudId: "cloud-9",
            url: "https://acme.atlassian.net",
            products: [{ id: "jira", access: "read-write" }],
          },
        ],
      },
    }),
    searchJiraIssuesUsingJql: () => ({ data: { issues: [ISSUE], isLast: true } }),
  });
  const jira = new JiraSource(
    new AtlassianClient(() => admin, { server: "atlassian", jql: DEFAULT_JQL }),
  );
  const {
    items: [item],
  } = await jira.list();
  NodeAssert.equal(item?.id, "PAY-42");
  NodeAssert.equal(calls[1]?.[1].cloudId, "cloud-9");
});

test("the data envelope is unwrapped only when it is the envelope", () => {
  NodeAssert.deepEqual(unwrapData({ data: { resources: [1] } }), { resources: [1] });
  NodeAssert.deepEqual(unwrapData({ data: { data: [2] } }), [2]);
  NodeAssert.deepEqual(unwrapData([{ data: 1 }]), [{ data: 1 }]);
  NodeAssert.deepEqual(unwrapData({ issues: [], data: { x: 1 } }), { issues: [], data: { x: 1 } });
  NodeAssert.equal(unwrapData("text"), "text");
});

test("no sites: the error quotes what the server returned", async () => {
  const { admin } = fakeAdmin({
    getAccessibleAtlassianResources: () => ({ data: { something: [] } }),
  });
  const jira = new JiraSource(
    new AtlassianClient(() => admin, { server: "atlassian", jql: DEFAULT_JQL }),
  );
  await NodeAssert.rejects(
    jira.list(),
    /no accessible sites \(the server said: \{"something":\[\]\}\)/,
  );
});

test("v2 search results: issues under issues.nodes, linked by their own webUrl", async () => {
  // The shape Rovo MCP v2 returns for searchJiraIssuesUsingJql, trimmed.
  const node = {
    id: "139818",
    key: "DEV-4635",
    webUrl: "https://medsky.example/browse/DEV-4635",
    fields: {
      summary: "Search exams",
      status: {
        name: "Em Progresso",
        statusCategory: { key: "indeterminate", name: "Em andamento" },
      },
    },
  };
  const { admin } = fakeAdmin({
    getAccessibleAtlassianResources: () => ({
      data: { resources: [{ cloudId: "cloud-9", url: "https://medsky.example" }] },
    }),
    searchJiraIssuesUsingJql: () => ({
      issues: { nodes: [node], pageInfo: { hasNextPage: true, endCursor: "x" } },
      webUrl: "https://medsky.example/issues",
      context: { cloudId: "cloud-9" },
    }),
  });
  const jira = new JiraSource(
    new AtlassianClient(() => admin, { server: "atlassian", jql: DEFAULT_JQL }),
  );
  const { items } = await jira.list();
  NodeAssert.deepEqual(
    items.map((item) => [item.id, item.title, item.status, item.statusCategory, item.url]),
    [
      [
        "DEV-4635",
        "Search exams",
        "Em Progresso",
        "in-progress",
        "https://medsky.example/browse/DEV-4635",
      ],
    ],
  );
});

test("lists come from arrays, named arrays or nodes connections", () => {
  NodeAssert.deepEqual(listOf([1], ["issues"]), [1]);
  NodeAssert.deepEqual(listOf({ issues: [2] }, ["issues"]), [2]);
  NodeAssert.deepEqual(listOf({ issues: { nodes: [3] } }, ["issues"]), [3]);
  NodeAssert.deepEqual(listOf({ nodes: [4] }, ["issues"]), [4]);
  NodeAssert.deepEqual(listOf({ other: [5] }, ["issues"]), []);
  NodeAssert.deepEqual(listOf(undefined, ["issues"]), []);
});

test("v2 issue detail: the issue arrives as a one-item issues.nodes list", async () => {
  const { admin } = fakeAdmin(
    {
      getJiraIssue: () => ({
        issues: {
          nodes: [
            {
              ...ISSUE,
              webUrl: "https://acme.atlassian.net/browse/PAY-42",
              fields: {
                ...ISSUE.fields,
                description: "Totals are off.",
                assignee: { displayName: "Dee" },
              },
            },
          ],
        },
        context: {},
      }),
      "executeRead:getTransitionsForJiraIssue": () => ({
        data: {
          transitions: [
            {
              id: "131",
              name: "Code review",
              to: { name: "In Code Review", statusCategory: { key: "indeterminate" } },
            },
          ],
        },
      }),
    },
    ["atlassian"],
    {
      tools: [
        "getAccessibleAtlassianResources",
        "searchJiraIssuesUsingJql",
        "getJiraIssue",
        "executeRead",
        "discover",
      ],
    },
  );
  const jira = new JiraSource(
    new AtlassianClient(() => admin, {
      server: "atlassian",
      site: "acme.atlassian.net",
      jql: DEFAULT_JQL,
    }),
  );
  const detail = await jira.detail("PAY-42");
  NodeAssert.equal(detail.title, "Fix rounding in invoice totals");
  NodeAssert.equal(detail.description, "Totals are off.");
  NodeAssert.ok(detail.facts.some((fact) => fact.label === "Assignee" && fact.value === "Dee"));
  NodeAssert.deepEqual(
    (await jira.actions("PAY-42")).map((action) => action.label),
    ["Code review"],
  );
});

test("the last list is saved, kept for a source whose refresh fails, and shared while loading", async () => {
  const path = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "work-items-")),
    "last-list.json",
  );
  let fail = false;
  let calls = 0;
  const jira = {
    name: "jira" as const,
    list: async () => {
      calls += 1;
      if (fail) throw new Error("timed out");
      return {
        items: [
          {
            source: "jira" as const,
            id: "PAY-1",
            kind: "issue" as const,
            title: "T",
            status: "To Do",
            statusCategory: "todo" as const,
          },
        ],
      };
    },
    detail: async () => {
      throw new Error("x");
    },
    actions: async () => [],
    apply: async () => {},
  };
  const service = new WorkItemsService([jira], new ListCache(path));
  NodeAssert.equal(service.saved(), undefined);
  const [one, two] = await Promise.all([service.list(), service.list()]);
  NodeAssert.equal(calls, 1, "two calls while loading share one refresh");
  NodeAssert.equal(one, two);

  // A new run reads it from disk.
  const restarted = new WorkItemsService([jira], new ListCache(path));
  NodeAssert.deepEqual(
    restarted.saved()?.sources[0]?.items.map((item) => item.id),
    ["PAY-1"],
  );

  fail = true;
  const failed = await restarted.list();
  NodeAssert.deepEqual(
    failed.sources[0]?.items.map((item) => item.id),
    ["PAY-1"],
    "the last items stay visible",
  );
  NodeAssert.equal(failed.sources[0]?.error, "timed out");
  NodeAssert.equal(failed.sources[0]?.staleSince, one.at);
});

// Shapes below are trimmed copies of replies from a live Rovo MCP v2 server (Nov 2026).

test("Bitbucket v2: only accepted inputs are sent, and PR ids come from the link when source/destination are empty", async () => {
  const listed = {
    id: 296,
    title: "Feature/DEV-4352",
    state: "OPEN",
    author: { display_name: "Ivo Gomes" },
    source: {},
    destination: {},
    updated_on: "2026-11-03T12:16:49.769393+00:00",
    links: { html: { href: "https://bitbucket.org/medsky/medportal/pull-requests/296" } },
    draft: false,
  };
  const { admin, calls } = fakeAdmin(
    {
      "executeRead:listMyBitbucketPullRequests": () => ({
        data: { values: [], page: 1, pagelen: 50, size: 0 },
      }),
      "executeRead:listMyBitbucketReviewRequests": () => ({
        data: {
          values: [listed],
          next: "https://api.bitbucket.org/…",
          page: 1,
          pagelen: 50,
          size: 1,
        },
      }),
      "executeRead:getBitbucketRepoPullRequest": () => ({
        data: {
          id: 296,
          title: "Feature/DEV-4352",
          state: "OPEN",
          author: { display_name: "Ivo Gomes" },
          source: {
            branch: { name: "feature/DEV-4352" },
            repository: { full_name: "medsky/medportal" },
          },
          destination: {
            branch: { name: "develop" },
            repository: { full_name: "medsky/medportal" },
          },
          links: { html: { href: "https://bitbucket.org/medsky/medportal/pull-requests/296" } },
          participants: [
            { role: "REVIEWER", approved: false, user: { display_name: "Nelson Barros" } },
          ],
          description: "",
        },
      }),
    },
    ["atlassian"],
    {
      tools: [
        "getAccessibleAtlassianResources",
        "searchJiraIssuesUsingJql",
        "getJiraIssue",
        "executeRead",
        "discover",
      ],
    },
  );
  const bitbucket = new BitbucketSource(
    new AtlassianClient(() => admin, {
      server: "atlassian",
      site: "cloud-1",
      jql: DEFAULT_JQL,
      bitbucketWorkspace: "medsky",
    }),
  );
  const {
    items: [item],
  } = await bitbucket.list();
  NodeAssert.deepEqual(
    [item?.id, item?.kind, item?.container, item?.url],
    [
      "medsky/medportal#296",
      "review",
      "medsky/medportal",
      "https://bitbucket.org/medsky/medportal/pull-requests/296",
    ],
  );
  const listCall = calls.find(([, args]) => args.name === "listMyBitbucketReviewRequests")!;
  NodeAssert.deepEqual(
    listCall[1].inputs,
    { workspaceId: "medsky", pagelen: 50 },
    "no extra workspace field: the server rejects the whole request",
  );

  const detail = await bitbucket.detail(item!.id);
  NodeAssert.deepEqual(
    calls.find(([, args]) => args.name === "getBitbucketRepoPullRequest")?.[1].inputs,
    { workspaceId: "medsky", repoId: "medportal", prId: 296 },
  );
  NodeAssert.ok(
    detail.facts.some(
      (fact) => fact.label === "Branch" && fact.value === "feature/DEV-4352 → develop",
    ),
  );
  NodeAssert.equal(
    repoFromLink("https://bitbucket.org/medsky/medportal-installer/pull-requests/515"),
    "medsky/medportal-installer",
  );
  NodeAssert.equal(repoFromLink(undefined), undefined);
});

test("Start work never moves an issue to blocked: it picks a transition that starts work, or none", () => {
  // DEV-4641 ("To Refine") offered: blocked (in progress), Canceled (done), Refined → A fazer (new).
  const toRefine = [
    { id: "91", label: "blocked", to: "blocked", toCategory: "in-progress" as const },
    { id: "161", label: "Canceled", to: "Canceled", toCategory: "done" as const },
    { id: "111", label: "Refined", to: "A fazer", toCategory: "todo" as const },
  ];
  NodeAssert.equal(startWorkAction(toRefine), undefined);
  NodeAssert.equal(
    startWorkAction([
      ...toRefine,
      { id: "21", label: "Iniciar", to: "Em Progresso", toCategory: "in-progress" },
    ])?.id,
    "21",
  );
  NodeAssert.equal(
    startWorkAction([
      { id: "131", label: "Code review", to: "In Code Review", toCategory: "in-progress" },
    ]),
    undefined,
  );
  NodeAssert.equal(
    startWorkAction([
      { id: "5", label: "Start progress", to: "In Progress", toCategory: "in-progress" },
    ])?.id,
    "5",
  );
  NodeAssert.equal(
    startWorkAction([{ id: "6", label: "Pausar", to: "Em espera", toCategory: "in-progress" }]),
    undefined,
  );
});

test("status categories without their key fall back on Jira category id and colour", () => {
  NodeAssert.equal(categoryOf("Em andamento", "indeterminate"), "in-progress");
  NodeAssert.equal(categoryOf("Em andamento", undefined, 4, "yellow"), "in-progress");
  NodeAssert.equal(categoryOf("Pendências", undefined, undefined, "blue-gray"), "todo");
  NodeAssert.equal(categoryOf("Concluído", undefined, 3), "done");
});

test("Jira links use the site address when an issue carries no link of its own", async () => {
  const { admin } = fakeAdmin({
    getAccessibleAtlassianResources: () => ({
      data: { resources: [{ cloudId: "d718f93f-cac4", url: "https://medsky.example" }] },
    }),
    searchJiraIssuesUsingJql: () => ({
      issues: {
        nodes: [
          {
            id: "1",
            key: "DEV-1",
            fields: {
              summary: "S",
              status: {
                name: "Em Progresso",
                statusCategory: {
                  id: 4,
                  key: "indeterminate",
                  colorName: "yellow",
                  name: "Em andamento",
                },
              },
            },
          },
        ],
      },
    }),
  });
  const {
    items: [item],
  } = await new JiraSource(
    new AtlassianClient(() => admin, { server: "atlassian", jql: DEFAULT_JQL }),
  ).list();
  NodeAssert.equal(item?.url, "https://medsky.example/browse/DEV-1");
  NodeAssert.equal(item?.statusCategory, "in-progress");
});

test("an unset Bitbucket workspace is found from the account, or asked for when there are several", async () => {
  const one = fakeAdmin(
    {
      "executeRead:listBitbucketWorkspaces": () => ({
        data: { values: [{ uuid: "{f187}", slug: "medsky" }], pagelen: 10, size: 1 },
      }),
      "executeRead:listMyBitbucketPullRequests": () => ({ data: { values: [] } }),
      "executeRead:listMyBitbucketReviewRequests": () => ({ data: { values: [] } }),
    },
    ["atlassian"],
    { tools: ["getAccessibleAtlassianResources", "executeRead"] },
  );
  const source = new BitbucketSource(
    new AtlassianClient(() => one.admin, {
      server: "atlassian",
      site: "cloud-1",
      jql: DEFAULT_JQL,
    }),
  );
  await source.list();
  await source.list();
  NodeAssert.equal(
    one.calls.filter(([, args]) => args.name === "listBitbucketWorkspaces").length,
    1,
    "looked up once",
  );
  NodeAssert.equal(
    (
      one.calls.find(([, args]) => args.name === "listMyBitbucketPullRequests")?.[1].inputs as
        | { workspaceId?: string }
        | undefined
    )?.workspaceId,
    "medsky",
  );

  const none = fakeAdmin(
    { "executeRead:listBitbucketWorkspaces": () => ({ data: { values: [] } }) },
    ["atlassian"],
    { tools: ["executeRead"] },
  );
  NodeAssert.deepEqual(
    await new BitbucketSource(
      new AtlassianClient(() => none.admin, { server: "atlassian", site: "c", jql: DEFAULT_JQL }),
    ).list(),
    { items: [] },
  );

  const several = fakeAdmin(
    {
      "executeRead:listBitbucketWorkspaces": () => ({
        data: { values: [{ slug: "a" }, { slug: "b" }] },
      }),
    },
    ["atlassian"],
    { tools: ["executeRead"] },
  );
  await NodeAssert.rejects(
    new BitbucketSource(
      new AtlassianClient(() => several.admin, {
        server: "atlassian",
        site: "c",
        jql: DEFAULT_JQL,
      }),
    ).list(),
    /several Bitbucket workspaces \(a, b\); set the Bitbucket workspace in Settings/,
  );
});

test("compact search replies (translated category names only) get their category from the site statuses", async () => {
  // The compact shape the server sent through the MCP connection, trimmed.
  const { admin, calls } = fakeAdmin(
    {
      getAccessibleAtlassianResources: () => ({
        data: { resources: [{ cloudId: "cloud-9", url: "https://medsky.example" }] },
      }),
      searchJiraIssuesUsingJql: () => ({
        data: {
          isLast: true,
          issues: [
            {
              id: "1",
              key: "DEV-4633",
              fields: {
                summary: "A",
                status: { name: "In Code Review", statusCategory: { name: "Em andamento" } },
              },
            },
            {
              id: "2",
              key: "DEV-4641",
              fields: {
                summary: "B",
                status: { name: "To Refine", statusCategory: { name: "Pendências" } },
              },
            },
            {
              id: "3",
              key: "DEV-9",
              fields: {
                summary: "C",
                status: { name: "Mystery", statusCategory: { name: "Algo" } },
              },
            },
          ],
        },
      }),
      "executeRead:listJiraStatuses": (args) => ({
        data: {
          mode: "site",
          statuses: {
            new: [
              { id: "10063", name: "To Refine" },
              { id: "1", name: "A fazer" },
            ],
            indeterminate: [
              { id: "10064", name: "In Code Review" },
              { id: "3", name: "Em Progresso" },
            ],
            done: [{ id: "10001", name: "Concluído" }],
          }[(args.inputs as { statusCategory: string }).statusCategory],
        },
      }),
    },
    ["atlassian"],
    {
      tools: [
        "getAccessibleAtlassianResources",
        "searchJiraIssuesUsingJql",
        "getJiraIssue",
        "executeRead",
      ],
    },
  );
  const jira = new JiraSource(
    new AtlassianClient(() => admin, { server: "atlassian", jql: DEFAULT_JQL }),
  );
  const { items } = await jira.list();
  NodeAssert.deepEqual(
    items.map((item) => [item.id, item.statusCategory, item.url]),
    [
      ["DEV-4633", "in-progress", "https://medsky.example/browse/DEV-4633"],
      ["DEV-4641", "todo", "https://medsky.example/browse/DEV-4641"],
      ["DEV-9", "unknown", "https://medsky.example/browse/DEV-9"],
    ],
  );
  await jira.list();
  NodeAssert.equal(
    calls.filter(([, args]) => args.name === "listJiraStatuses").length,
    3,
    "the statuses are read once, one call per category",
  );
});

test("a hung gh is killed after its time limit and fails with a clear message", async () => {
  const node = process.execPath;
  NodeAssert.equal(await ghRunner({ command: node })(["-e", 'process.stdout.write("ok")']), "ok");
  await NodeAssert.rejects(
    ghRunner({ command: node, timeoutMs: 300 })(["-e", "setTimeout(() => {}, 60000)"]),
    /did not answer within 0\.3 s/,
  );

  // Only the GitHub source shows the failure.
  const jira = {
    name: "jira" as const,
    list: async () => ({
      items: [
        {
          source: "jira" as const,
          id: "PAY-1",
          kind: "issue" as const,
          title: "T",
          status: "To Do",
          statusCategory: "todo" as const,
        },
      ],
    }),
    detail: async () => {
      throw new Error("x");
    },
    actions: async () => [],
    apply: async () => {},
  };
  const hung = new GitHubSource(() =>
    ghRunner({ command: node, timeoutMs: 200 })(["-e", "setTimeout(() => {}, 60000)"]),
  );
  const { sources } = await new WorkItemsService([jira, hung]).list();
  NodeAssert.deepEqual(
    sources.map((list) => [list.source, list.items.length, Boolean(list.error)]),
    [
      ["jira", 1, false],
      ["github", 0, true],
    ],
  );
  NodeAssert.match(sources[1]!.error!, /did not answer within 0\.2 s/);
});

test("Jira says when the search has more than it lists, with the count when one can be had", async () => {
  // v2 search page (pageInfo) and count-only reply, as the live server sends them.
  const node = (n: number) => ({
    id: String(n),
    key: `DEV-${n}`,
    fields: {
      summary: "S",
      status: { name: "A fazer", statusCategory: { id: 2, key: "new", name: "Pendências" } },
    },
  });
  const v2 = fakeAdmin({
    searchJiraIssuesUsingJql: (args) =>
      args.searchResultMode === "count"
        ? {
            issues: { totalCount: 132, nodes: [], webUrl: "https://medsky.example/issues" },
            context: {},
          }
        : {
            issues: { nodes: [node(1), node(2)], pageInfo: { hasNextPage: true, endCursor: "x" } },
            context: {},
          },
  });
  const page = await new JiraSource(
    new AtlassianClient(() => v2.admin, {
      server: "atlassian",
      site: "medsky.example",
      jql: DEFAULT_JQL,
    }),
  ).list();
  NodeAssert.deepEqual([page.items.length, page.more, page.total], [2, true, 132]);
  NodeAssert.deepEqual(v2.calls.at(-1)?.[1], {
    cloudId: "medsky.example",
    jql: DEFAULT_JQL,
    searchResultMode: "count",
    maxResults: 1,
    fields: ["summary"],
  });

  // Compact reply with isLast: false, and a server that refuses the count: still "more".
  let counted = 0;
  const compact = fakeAdmin({
    searchJiraIssuesUsingJql: (args) => {
      if (args.searchResultMode) {
        counted += 1;
        throw new Error("searchResultMode is not accepted");
      }
      return { data: { isLast: false, nextPageToken: "n", issues: [node(1)] } };
    },
  });
  const partial = await new JiraSource(
    new AtlassianClient(() => compact.admin, { server: "atlassian", site: "c", jql: DEFAULT_JQL }),
  ).list();
  NodeAssert.deepEqual(
    [partial.items.length, partial.more, partial.total, counted],
    [1, true, undefined, 1],
  );

  // The last page: nothing more, and no count is asked for.
  const done = fakeAdmin({
    searchJiraIssuesUsingJql: () => ({ data: { isLast: true, issues: [node(1)] } }),
  });
  const last = await new JiraSource(
    new AtlassianClient(() => done.admin, { server: "atlassian", site: "c", jql: DEFAULT_JQL }),
  ).list();
  NodeAssert.deepEqual([last.more, last.total, done.calls.length], [undefined, undefined, 1]);
});

test("Bitbucket and GitHub say when there are more", async () => {
  const pr = (id: number) => ({
    id,
    title: `PR ${id}`,
    state: "OPEN",
    links: { html: { href: `https://bitbucket.org/medsky/medportal/pull-requests/${id}` } },
  });
  const { admin } = fakeAdmin(
    {
      "executeRead:listMyBitbucketPullRequests": () => ({
        data: { values: [pr(1)], page: 1, pagelen: 50, size: 1 },
      }),
      "executeRead:listMyBitbucketReviewRequests": () => ({
        data: {
          values: [pr(2), pr(3)],
          next: "https://api.bitbucket.org/…?page=2",
          page: 1,
          pagelen: 50,
          size: 66,
        },
      }),
    },
    ["atlassian"],
    { tools: ["executeRead"] },
  );
  const page = await new BitbucketSource(
    new AtlassianClient(() => admin, {
      server: "atlassian",
      site: "c",
      jql: DEFAULT_JQL,
      bitbucketWorkspace: "medsky",
    }),
  ).list();
  NodeAssert.deepEqual([page.items.length, page.more, page.total], [3, true, 67]);

  const hits = Array.from({ length: 51 }, (_, n) => ({
    number: n + 1,
    title: "T",
    state: "open",
    repository: { nameWithOwner: "a/b" },
  }));
  const github = await new GitHubSource(async (args) =>
    args[1] === "issues" ? JSON.stringify(hits) : "[]",
  ).list();
  NodeAssert.deepEqual([github.items.length, github.more], [50, true]);
  NodeAssert.equal(
    (await new GitHubSource(async () => JSON.stringify(hits.slice(0, 50))).list()).more,
    undefined,
  );

  // The service passes it on, and keeps it with a stale list.
  let fail = false;
  const source = {
    name: "github" as const,
    list: async () => {
      if (fail) throw new Error("offline");
      return { items: github.items, more: true, total: 70 };
    },
    detail: async () => {
      throw new Error("x");
    },
    actions: async () => [],
    apply: async () => {},
  };
  const service = new WorkItemsService([source]);
  const fresh = await service.list();
  NodeAssert.deepEqual([fresh.sources[0]?.more, fresh.sources[0]?.total], [true, 70]);
  fail = true;
  const stale = await service.list();
  NodeAssert.deepEqual(
    [stale.sources[0]?.more, stale.sources[0]?.total, stale.sources[0]?.error],
    [true, 70, "offline"],
  );
});

// Comment replies below are the live Rovo MCP v2 shapes (Nov 2026), with made-up names and text.

test("Jira detail shows the latest comments, oldest first, as plain text", async () => {
  const { admin, calls } = fakeAdmin(
    {
      getJiraIssue: () => ({ issues: { nodes: [ISSUE] }, context: {} }),
      listJiraIssueComments: () => ({
        data: {
          startAt: 0,
          maxResults: 20,
          total: 45,
          isLast: false,
          appliedContentFormat: "html",
          comments: [
            {
              id: "45024",
              author: { displayName: "Dee" },
              body: "<p>Released in 4.4.0 &amp; deployed</p>",
              created: "2025-05-14T10:07:56.908+0100",
              updated: "2025-05-14T10:07:56.908+0100",
              jsdPublic: true,
            },
            {
              id: "33772",
              author: { displayName: "Rui" },
              body: '<p><span data-type="mention" data-user-id="5ea0">@Dee</span> please add an example</p>',
              created: "2025-02-24T08:51:10.034+0000",
              updated: "2025-02-24T08:51:10.034+0000",
              jsdPublic: true,
              visibility: { type: "role", value: "Developers" },
            },
          ],
        },
      }),
    },
    ["atlassian"],
    {
      tools: [
        "getAccessibleAtlassianResources",
        "searchJiraIssuesUsingJql",
        "getJiraIssue",
        "listJiraIssueComments",
        "executeRead",
      ],
    },
  );
  const detail = await new JiraSource(
    new AtlassianClient(() => admin, {
      server: "atlassian",
      site: "acme.atlassian.net",
      jql: DEFAULT_JQL,
    }),
  ).detail("PAY-42");
  NodeAssert.deepEqual(detail.comments, [
    {
      author: "Rui",
      body: "@Dee please add an example",
      created: "2025-02-24T08:51:10.034+0000",
      note: "visible to Developers",
    },
    {
      author: "Dee",
      body: "Released in 4.4.0 & deployed",
      created: "2025-05-14T10:07:56.908+0100",
    },
  ]);
  NodeAssert.equal(detail.commentTotal, 45);
  NodeAssert.ok(detail.facts.some((fact) => fact.label === "Comments" && fact.value === "45"));
  NodeAssert.deepEqual(calls.find(([tool]) => tool === "listJiraIssueComments")?.[1], {
    cloudId: "acme.atlassian.net",
    issueIdOrKey: "PAY-42",
    maxResults: 20,
    responseContentFormat: "markdown",
    orderBy: "-created",
  });
});

test("Jira comments: a server that ignores the order is read from the last page; a failure leaves the detail", async () => {
  const comment = (n: number) => ({
    id: String(n),
    author: { displayName: `P${n}` },
    body: `c${n}`,
    created: new Date(Date.UTC(2026, 0, n)).toISOString(),
  });
  const { admin, calls } = fakeAdmin(
    {
      getJiraIssue: () => ISSUE,
      "executeRead:listJiraIssueComments": (args) => {
        const startAt = (args.inputs as { startAt?: number }).startAt ?? 0;
        return {
          data: {
            startAt,
            total: 25,
            comments: Array.from({ length: Math.min(20, 25 - startAt) }, (_, i) =>
              comment(startAt + i + 1),
            ),
          },
        };
      },
    },
    ["atlassian"],
    { tools: ["getJiraIssue", "executeRead"] },
  );
  const detail = await new JiraSource(
    new AtlassianClient(() => admin, { server: "atlassian", site: "c", jql: DEFAULT_JQL }),
  ).detail("PAY-42");
  NodeAssert.deepEqual(
    detail.comments?.map((c) => c.body),
    Array.from({ length: 20 }, (_, i) => `c${i + 6}`),
  );
  NodeAssert.equal(detail.commentTotal, 25);
  NodeAssert.equal((calls.at(-1)![1].inputs as { startAt?: number }).startAt, 5);

  // No comment list at all: the issue's own embedded comments stand in, else the error is reported.
  const embedded = fakeAdmin(
    {
      getJiraIssue: () => ({
        ...ISSUE,
        fields: {
          ...ISSUE.fields,
          comment: {
            total: 1,
            comments: [
              {
                author: { displayName: "Dee" },
                body: "Looks good",
                created: "2026-01-01T00:00:00.000+0000",
              },
            ],
          },
        },
      }),
    },
    ["atlassian"],
    { tools: ["getJiraIssue", "executeRead"] },
  );
  const fallback = await new JiraSource(
    new AtlassianClient(() => embedded.admin, { server: "atlassian", site: "c", jql: DEFAULT_JQL }),
  ).detail("PAY-42");
  NodeAssert.deepEqual(
    fallback.comments?.map((c) => [c.author, c.body]),
    [["Dee", "Looks good"]],
  );
  NodeAssert.equal(fallback.commentsError, undefined);
  const none = fakeAdmin({ getJiraIssue: () => ISSUE }, ["atlassian"], {
    tools: ["getJiraIssue", "executeRead"],
  });
  const bare = await new JiraSource(
    new AtlassianClient(() => none.admin, { server: "atlassian", site: "c", jql: DEFAULT_JQL }),
  ).detail("PAY-42");
  NodeAssert.equal(bare.title, "Fix rounding in invoice totals");
  NodeAssert.match(bare.commentsError ?? "", /^listJiraIssueComments: /);
});

test("Bitbucket pull request comments: inline ones say where, deleted and draft ones are left out", async () => {
  const { admin, calls } = fakeAdmin(
    {
      "executeRead:getBitbucketRepoPullRequest": () => ({
        data: {
          id: 289,
          title: "Detach users",
          state: "MERGED",
          links: { html: { href: "https://bitbucket.org/medsky/medportal/pull-requests/289" } },
        },
      }),
      "executeRead:listBitbucketRepoPullRequestComments": () => ({
        data: {
          values: [
            {
              id: 887920833,
              content: { raw: "##### Minor\n\nRun these in parallel.\n" },
              user: { display_name: "Review Bot" },
              created_on: "2026-10-23T11:37:43.883941+00:00",
              inline: { path: "apps/server/src/account-user.service.ts" },
              pending: false,
            },
            {
              id: 887920900,
              content: { raw: "Done, thanks" },
              user: { display_name: "Dee" },
              created_on: "2026-10-23T12:00:00.000000+00:00",
              pending: false,
            },
            {
              id: 887920901,
              content: { raw: "oops" },
              user: { display_name: "Dee" },
              created_on: "2026-10-23T12:01:00.000000+00:00",
              deleted: true,
            },
            {
              id: 887920902,
              content: { raw: "draft" },
              user: { display_name: "Dee" },
              created_on: "2026-10-23T12:02:00.000000+00:00",
              pending: true,
            },
          ],
          pagelen: 100,
          size: 4,
        },
      }),
    },
    ["atlassian"],
    { tools: ["executeRead"] },
  );
  const detail = await new BitbucketSource(
    new AtlassianClient(() => admin, {
      server: "atlassian",
      site: "c",
      jql: DEFAULT_JQL,
      bitbucketWorkspace: "medsky",
    }),
  ).detail("medsky/medportal#289");
  NodeAssert.deepEqual(detail.comments, [
    {
      author: "Review Bot",
      body: "##### Minor\n\nRun these in parallel.",
      created: "2026-10-23T11:37:43.883941+00:00",
      note: "on apps/server/src/account-user.service.ts",
    },
    { author: "Dee", body: "Done, thanks", created: "2026-10-23T12:00:00.000000+00:00" },
  ]);
  NodeAssert.equal(detail.commentTotal, undefined);
  NodeAssert.deepEqual(
    calls.find(([, args]) => args.name === "listBitbucketRepoPullRequestComments")?.[1].inputs,
    { workspaceId: "medsky", repoId: "medportal", prId: 289, pagelen: 100 },
  );
});

test("GitHub detail keeps the latest 20 conversation comments", async () => {
  const comments = Array.from({ length: 23 }, (_, n) => ({
    author: { login: `u${n}` },
    body: `c${n}`,
    createdAt: new Date(Date.UTC(2026, 0, n + 1)).toISOString(),
  }));
  const github = new GitHubSource(async () =>
    JSON.stringify({
      number: 5,
      title: "T",
      state: "OPEN",
      url: "https://github.com/me/site/pull/5",
      comments,
    }),
  );
  const detail = await github.detail("me/site#5");
  NodeAssert.equal(detail.comments?.length, 20);
  NodeAssert.deepEqual(
    [detail.comments?.[0]?.body, detail.comments?.at(-1)?.body, detail.commentTotal],
    ["c3", "c22", 23],
  );
});

test("comment bodies: HTML and document format become plain text, markdown stays", () => {
  NodeAssert.equal(
    plainText("<p>One<br/>two</p><ul><li>a</li><li>b</li></ul>", true),
    "One\ntwo\n- a\n- b",
  );
  NodeAssert.equal(plainText("<p>x &lt;T&gt; &#233;</p>"), "x <T> é");
  NodeAssert.equal(plainText("Use `Array<T>` here"), "Use `Array<T>` here");
  NodeAssert.equal(
    plainText({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { text: "@Dee" } },
            { type: "text", text: " see this" },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "Next" }] },
      ],
    }),
    "@Dee see this\nNext",
  );
  NodeAssert.deepEqual(
    latestComments(
      [
        { author: "b", body: "2", created: "2026-01-02T00:00:00Z" },
        { author: "a", body: "1", created: "2026-01-01T00:00:00Z" },
      ],
      1,
    ).map((c) => c.body),
    ["2"],
  );
});

// Diffs below follow the shape of a live getBitbucketRepoPullRequestDiff reply (Nov 2026):
// {"data":{"diff":"diff --git a/… b/…\nindex …\n--- a/…\n+++ b/…\n@@ …"}}, with made-up content.

/** One file's section of a git diff, changing `lines` lines (or adding them, for a new file). */
function fileDiff(path: string, lines: number, { added = false, filler = "x" } = {}): string {
  const body = Array.from({ length: lines }, (_, n) =>
    added ? [`+${filler} ${n}`] : [`-old ${filler} ${n}`, `+new ${filler} ${n}`],
  ).flat();
  return [
    `diff --git a/${path} b/${path}`,
    ...(added
      ? ["new file mode 100644", "index 0000000000..65f0b55556", "--- /dev/null"]
      : ["index 0731543759..65f0b55556 100644", `--- a/${path}`]),
    `+++ b/${path}`,
    `@@ -1,${added ? 0 : lines} +1,${lines} @@`,
    ...body,
    "",
  ].join("\n");
}

test("issue keys come from PR titles and branches; branch names are short ASCII slugs", () => {
  NodeAssert.deepEqual(issueKeysIn("[#DEV-4635] - Search exams", "feature/DEV-4635-search"), [
    "DEV-4635",
  ]);
  NodeAssert.deepEqual(issueKeysIn("Bugfix/DEV-4632", "bugfix/DEV-4632"), ["DEV-4632"]);
  NodeAssert.deepEqual(issueKeysIn("PAY-1 and OPS2-30: use UTF-8 and SHA-256", undefined), [
    "PAY-1",
    "OPS2-30",
  ]);
  NodeAssert.deepEqual(issueKeysIn("fix dev-12 lowercase", "main"), []);

  NodeAssert.equal(
    branchName("DEV-123", "Corrigir validação do Código Postal (São João)"),
    "feature/DEV-123-corrigir-validacao-do-codigo-postal-sao",
  );
  NodeAssert.equal(branchName("DEV-9", "[DEV-9] Straße & Œuvre"), "feature/DEV-9-strasse-oeuvre");
  NodeAssert.equal(branchName("DEV-9", "!!!", "bugfix/"), "bugfix/DEV-9");
  NodeAssert.equal(branchName("42", "Docs typo", ""), "42-docs-typo");
  NodeAssert.equal(branchSlug("a".repeat(50)), "a".repeat(40), "one long word is cut at the limit");
  NodeAssert.ok(branchSlug("Search exams with Advanced Search on the Exams page").length <= 40);
  NodeAssert.equal(
    branchSlug("Search exams with Advanced Search on the Exams page"),
    "search-exams-with-advanced-search-on-the",
  );
});

test("Bitbucket: the diff is read with getBitbucketRepoPullRequestDiff; PRs carry the issue keys they name", async () => {
  const { admin, calls } = fakeAdmin(
    {
      // The list leaves source and destination empty, so its keys come from the title only.
      "executeRead:listMyBitbucketPullRequests": () => ({
        data: {
          values: [
            {
              id: 312,
              title: "[#DEV-4635] - Search exams with Advanced Search",
              state: "OPEN",
              source: {},
              destination: {},
              links: { html: { href: "https://bitbucket.org/medsky/medportal/pull-requests/312" } },
            },
          ],
          page: 1,
          pagelen: 50,
          size: 1,
        },
      }),
      "executeRead:listMyBitbucketReviewRequests": () => ({
        data: { values: [], page: 1, pagelen: 50, size: 0 },
      }),
      "executeRead:getBitbucketRepoPullRequest": () => ({
        data: {
          id: 289,
          title: "Handle HL7 usernames",
          state: "OPEN",
          source: {
            branch: { name: "bugfix/DEV-4632" },
            repository: { full_name: "medsky/medportal" },
          },
          destination: { branch: { name: "dev" } },
          links: { html: { href: "https://bitbucket.org/medsky/medportal/pull-requests/289" } },
        },
      }),
      "executeRead:getBitbucketRepoPullRequestDiff": () => ({
        data: { diff: fileDiff("apps/a.ts", 2) },
      }),
    },
    ["atlassian"],
    { tools: ["executeRead"] },
  );
  const bitbucket = new BitbucketSource(
    new AtlassianClient(() => admin, {
      server: "atlassian",
      site: "c",
      jql: DEFAULT_JQL,
      bitbucketWorkspace: "medsky",
    }),
  );
  NodeAssert.deepEqual(
    (await bitbucket.list()).items.map((item) => item.issueKeys),
    [["DEV-4635"]],
  );
  NodeAssert.deepEqual(
    (await bitbucket.detail("medsky/medportal#289")).issueKeys,
    ["DEV-4632"],
    "the detail adds the keys in the source branch",
  );
  NodeAssert.match(
    await bitbucket.diff("medsky/medportal#289"),
    /^diff --git a\/apps\/a\.ts b\/apps\/a\.ts\n/,
  );
  NodeAssert.deepEqual(
    calls.find(([, args]) => args.name === "getBitbucketRepoPullRequestDiff")?.[1],
    {
      name: "getBitbucketRepoPullRequestDiff",
      cloudId: "c",
      inputs: { workspaceId: "medsky", repoId: "medportal", prId: 289 },
    },
  );

  NodeAssert.equal(
    diffText("diff --git a/x b/x\n"),
    "diff --git a/x b/x\n",
    "a bare text reply is the diff",
  );
  NodeAssert.equal(diffText({ diff: "" }), "");
  NodeAssert.throws(() => diffText({ something: 1 }), /sent no diff/);
});

test("a diff is split into files with their paths and change counts", () => {
  const diff =
    fileDiff("api-client-collections/Auth/First Login New Password.bru", 3, { added: true }) +
    fileDiff("apps/server/src/hl7.service.ts", 2) +
    [
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "index 1..0",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "",
    ].join("\n") +
    [
      "diff --git a/logo.png b/logo.png",
      "index 1..2 100644",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n");
  NodeAssert.deepEqual(
    diffFiles(diff).map((file) => [file.path, file.additions, file.deletions]),
    [
      ["api-client-collections/Auth/First Login New Password.bru", 3, 0],
      ["apps/server/src/hl7.service.ts", 2, 2],
      ["old.txt", 0, 1],
      ["logo.png", 0, 0],
    ],
  );
  NodeAssert.equal(
    diffFiles(diff)
      .map((file) => file.text)
      .join(""),
    diff,
    "the sections add up to the whole diff",
  );
  NodeAssert.deepEqual(diffFiles(""), []);
});

test("a large diff keeps whole files up to the budget, code first, and lists the rest", () => {
  const small = fileDiff("src/a.ts", 5);
  const big = fileDiff("src/big.ts", 400);
  const lock = fileDiff("pnpm-lock.yaml", 20);
  const doc = fileDiff("docs/guide.md", 5);
  const last = fileDiff("src/z.ts", 5);
  const diff = lock + doc + small + big + last;
  const budget = small.length + last.length + 10;
  const trimmed = trimDiff(diff, budget);
  NodeAssert.equal(
    trimmed.text,
    small + last,
    "whole files only, in their diff order; docs and lockfiles make way for code",
  );
  NodeAssert.equal(trimmed.files, 5);
  NodeAssert.deepEqual(
    trimmed.omitted.map((file) => [file.path, file.additions, file.deletions, file.chars]),
    [
      ["pnpm-lock.yaml", 20, 20, lock.length],
      ["docs/guide.md", 5, 5, doc.length],
      ["src/big.ts", 400, 400, big.length],
    ],
  );
  NodeAssert.equal(
    trimDiff(diff, small.length + last.length + doc.length).text,
    doc + small + last,
    "docs come before generated files",
  );
  NodeAssert.equal(
    trimDiff(diff, diff.length).omitted.length,
    0,
    "a diff within the budget is kept whole",
  );

  // Not one file fits: the first is shown up to the budget, ending on a whole line.
  const cut = trimDiff(big + fileDiff("src/y.ts", 300), 500);
  NodeAssert.equal(cut.partial, "src/big.ts");
  NodeAssert.ok(cut.text.length <= 501 && cut.text.endsWith("\n") && big.startsWith(cut.text));
  NodeAssert.deepEqual(
    cut.omitted.map((file) => file.path),
    ["src/y.ts"],
  );
});

test("the review prompt carries the PR, its comments and its trimmed diff", () => {
  const item = {
    source: "bitbucket" as const,
    id: "medsky/medportal#289",
    kind: "review" as const,
    title: "Bugfix/DEV-4632",
    status: "OPEN",
    statusCategory: "in-progress" as const,
    url: "https://bitbucket.org/medsky/medportal/pull-requests/289",
    container: "medsky/medportal",
    issueKeys: ["DEV-4632"],
    description: "* \\[#DEV-4632\\] - Handle empty usernames",
    facts: [
      { label: "Author", value: "Dee" },
      { label: "Branch", value: "bugfix/DEV-4632 → dev" },
    ],
    comments: [
      {
        author: "Review Bot",
        body: "##### Minor\n\nRun these in parallel.",
        created: "2026-10-23T11:37:43.883941+00:00",
        note: "on apps/a.ts",
      },
    ],
    commentTotal: 31,
  };
  const markdown = fileDiff("docs/login.md", 1, { filler: "```ts" });
  const big = fileDiff("apps/server/src/hl7.service.ts", 400);
  const prompt = reviewPrompt(item, { text: markdown + big }, markdown.length + 100);
  NodeAssert.match(
    prompt,
    /^Please review Bitbucket pull request medsky\/medportal#289: "Bugfix\/DEV-4632"\./,
  );
  for (const line of [
    "- Branch: bugfix/DEV-4632 → dev",
    "- Linked issues: DEV-4632",
    "- Link: https://bitbucket.org/medsky/medportal/pull-requests/289",
    "* \\[#DEV-4632\\] - Handle empty usernames",
  ])
    NodeAssert.ok(prompt.includes(line), line);
  NodeAssert.match(
    prompt,
    /Comments \(the latest 1 of 31, oldest first\):\n\nReview Bot \(2026-10-23, on apps\/a\.ts\):\n> ##### Minor\n>\s\n> Run these in parallel\./,
  );
  NodeAssert.match(
    prompt,
    /Diff, trimmed to fit this message: 1 of 2 files, about [\d,]+ of [\d,]+ characters:/,
  );
  NodeAssert.ok(
    prompt.includes(`\n\`\`\`\`diff\n${markdown.trimEnd()}\n\`\`\`\`\n`),
    "a fence longer than the backticks in the diff",
  );
  NodeAssert.match(
    prompt,
    /Left out of the diff above.*\n- apps\/server\/src\/hl7\.service\.ts \(\+400 −400, [\d,]+ characters\)/,
  );
  NodeAssert.match(
    prompt,
    /grouped by severity \(critical, major, minor, nit\)\. For each, give the file and line/,
  );
  NodeAssert.match(prompt, /do not comment on, approve, decline or merge the pull request/);

  const whole = reviewPrompt(item, { text: markdown });
  NodeAssert.match(whole, /Diff \(1 file\):/);
  NodeAssert.doesNotMatch(whole, /Left out/);
  NodeAssert.match(
    reviewPrompt(item, { error: "getBitbucketRepoPullRequestDiff: 404" }),
    /The diff could not be loaded \(getBitbucketRepoPullRequestDiff: 404\)\. Read the changes from the link/,
  );
});

test("the service builds review prompts for pull requests only, saying when the diff fails", async () => {
  let failDiff = false;
  const { admin } = fakeAdmin(
    {
      "executeRead:getBitbucketRepoPullRequest": () => ({
        data: {
          id: 289,
          title: "Handle HL7 usernames",
          state: "OPEN",
          source: { branch: { name: "bugfix/DEV-4632" } },
          destination: { branch: { name: "dev" } },
          links: { html: { href: "https://bitbucket.org/medsky/medportal/pull-requests/289" } },
        },
      }),
      "executeRead:listBitbucketRepoPullRequestComments": () => ({
        data: { values: [], pagelen: 100, size: 0 },
      }),
      "executeRead:getBitbucketRepoPullRequestDiff": () => {
        if (failDiff) throw new Error("boom");
        return { data: { diff: fileDiff("apps/a.ts", 1) + fileDiff("apps/b.ts", 3000) } };
      },
    },
    ["atlassian"],
    { tools: ["executeRead"] },
  );
  const client = new AtlassianClient(() => admin, {
    server: "atlassian",
    site: "c",
    jql: DEFAULT_JQL,
    bitbucketWorkspace: "medsky",
  });
  const service = new WorkItemsService([new JiraSource(client), new BitbucketSource(client)]);
  const prompt = await service.reviewPrompt("bitbucket", "medsky/medportal#289");
  NodeAssert.match(prompt, /- Branch: bugfix\/DEV-4632 → dev/);
  NodeAssert.match(
    prompt,
    /trimmed to fit this message: 1 of 2 files/,
    "a diff over the default budget is trimmed",
  );
  NodeAssert.match(prompt, /- apps\/b\.ts \(\+3000 −3000/);
  failDiff = true;
  NodeAssert.match(
    await service.reviewPrompt("bitbucket", "medsky/medportal#289"),
    /The diff could not be loaded/,
  );
  await NodeAssert.rejects(
    service.reviewPrompt("jira", "PAY-42"),
    /jira has no pull requests to review/,
  );
});

test("GitHub pull requests: branches from gh pr view, the diff from gh pr diff", async () => {
  const runs: string[][] = [];
  const github = new GitHubSource(async (args) => {
    runs.push(args);
    if (args[0] === "search" && args[1] === "prs" && args[2] === "--author=@me")
      return JSON.stringify([
        {
          number: 7,
          title: "PAY-42 Fix rounding",
          state: "open",
          url: "https://github.com/me/site/pull/7",
          repository: { nameWithOwner: "me/site" },
        },
      ]);
    if (args[0] === "search") return "[]";
    if (args[0] === "issue")
      return JSON.stringify({
        number: 7,
        title: "Fix rounding",
        state: "OPEN",
        url: "https://github.com/me/site/pull/7",
        comments: [],
      });
    if (args[0] === "pr" && args[1] === "view")
      return JSON.stringify({ headRefName: "feature/PAY-42-fix-rounding", baseRefName: "main" });
    if (args[0] === "pr" && args[1] === "diff") return fileDiff("src/a.ts", 1);
    return "";
  });
  NodeAssert.deepEqual(
    (await github.list()).items.map((item) => [item.id, item.issueKeys]),
    [["me/site#7", ["PAY-42"]]],
  );
  const detail = await github.detail("me/site#7");
  NodeAssert.deepEqual([detail.kind, detail.issueKeys], ["pull-request", ["PAY-42"]]);
  NodeAssert.ok(
    detail.facts.some(
      (fact) => fact.label === "Branch" && fact.value === "feature/PAY-42-fix-rounding → main",
    ),
  );
  const prompt = await new WorkItemsService([github]).reviewPrompt("github", "me/site#7");
  NodeAssert.match(prompt, /^Please review GitHub pull request me\/site#7: "Fix rounding"\./);
  NodeAssert.deepEqual(
    runs.find((args) => args[1] === "diff"),
    ["pr", "diff", "7", "-R", "me/site", "--color=never"],
  );
  NodeAssert.match(prompt, /```diff\ndiff --git a\/src\/a\.ts/);
});

test("Start work offers a branch for issues, with the configured prefix, and the prompt asks to create it", async () => {
  const jira = {
    name: "jira" as const,
    list: async () => ({ items: [] }),
    detail: async (id: string) => ({
      source: "jira" as const,
      id,
      kind: "issue" as const,
      title: "Fix rounding in invoice totals",
      status: "To Do",
      statusCategory: "todo" as const,
      facts: [],
    }),
    actions: async () => [],
    apply: async () => {},
  };
  NodeAssert.equal(
    (await new WorkItemsService([jira]).detail("jira", "PAY-42")).branch,
    "feature/PAY-42-fix-rounding-in-invoice-totals",
  );
  const detail = await new WorkItemsService([jira], new ListCache(), {
    branchPrefix: "feat/",
  }).detail("jira", "PAY-42");
  NodeAssert.equal(detail.branch, "feat/PAY-42-fix-rounding-in-invoice-totals");

  const prompt = startPrompt(detail, { branch: detail.branch! });
  NodeAssert.match(
    prompt,
    /First, create the branch `feat\/PAY-42-fix-rounding-in-invoice-totals` from the up-to-date default branch \(fetch it from the remote first\) and switch to it\. If that branch already exists, switch to it instead\.\nThen explore the relevant code and propose a short plan before changing anything\.$/,
  );
  NodeAssert.doesNotMatch(
    startPrompt(detail),
    /create the branch/,
    "without the option, no branch step",
  );

  const github = new GitHubSource(async () =>
    JSON.stringify({
      number: 5,
      title: "Docs typo",
      state: "OPEN",
      url: "https://github.com/me/site/issues/5",
      comments: [],
    }),
  );
  NodeAssert.equal(
    (await new WorkItemsService([github]).detail("github", "me/site#5")).branch,
    "feature/5-docs-typo",
  );
  const pull = new GitHubSource(async (args) =>
    JSON.stringify(
      args[0] === "pr"
        ? {}
        : {
            number: 6,
            title: "T",
            state: "OPEN",
            url: "https://github.com/me/site/pull/6",
            comments: [],
          },
    ),
  );
  NodeAssert.equal(
    (await new WorkItemsService([pull]).detail("github", "me/site#6")).branch,
    undefined,
    "pull requests already have a branch",
  );
});

test("the server plugin reads the shared MCP servers per request, saves its settings and reports failures as JSON", async () => {
  const settings = new Map<string, JsonValue>();
  const routes = new Map<
    string,
    (request: GooseHttpRequest) => Promise<GooseHttpResponse> | GooseHttpResponse
  >();
  let enabled = false;
  const store = {
    get: async (key: string) => settings.get(key),
    set: async (key: string, value: JsonValue) => void settings.set(key, value),
    delete: async (key: string) => void settings.delete(key),
    keys: async () => [...settings.keys()],
  };
  await server.activate({
    pluginId: "my-work",
    pluginDir: "",
    dataDir: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "my-work-")),
    log: { info() {}, warn() {}, error() {} },
    settings: store,
    storage: store,
    secrets: { get: async () => undefined, async set() {}, async delete() {} },
    events: { on() {} },
    http: { route: (method, path, handler) => void routes.set(`${method} ${path}`, handler) },
    mcp: {
      registerTool() {},
      servers: async () => [
        { name: "atlassian", url: "https://mcp.atlassian.com/v2/mcp", enabled },
      ],
      listTools: async () => [{ name: "getAccessibleAtlassianResources", inputSchema: {} }],
      callTool: async () => ({
        isError: false,
        content: [{ type: "text", text: JSON.stringify([{ id: "cloud-1" }]) }],
      }),
    },
  });
  const call = (key: string, request: Partial<GooseHttpRequest> = {}) =>
    routes.get(key)!({
      method: key.split(" ")[0]!,
      path: key.split(" ")[1]!,
      query: new URLSearchParams(),
      headers: {},
      body: undefined,
      ...request,
    });

  const off = await call("GET /diagnose");
  NodeAssert.match(String((off.body as { report: string }).report), /"atlassian" is turned off/);
  enabled = true;
  NodeAssert.match(
    String(((await call("GET /diagnose")).body as { report: string }).report),
    /✓ Site .*cloud-1/,
  );

  NodeAssert.deepEqual(await call("GET /detail"), {
    status: 400,
    body: { error: "source is required" },
  });
  NodeAssert.deepEqual(
    await call("GET /actions", { query: new URLSearchParams({ source: "github", id: "a/b#1" }) }),
    {
      status: 502,
      body: { error: 'source "github" is not enabled' },
    },
  );

  await call("PUT /config", { body: { atlassian: { enabled: false }, github: { enabled: true } } });
  NodeAssert.deepEqual(settings.get("config"), {
    atlassian: { enabled: false },
    github: { enabled: true },
  });
  NodeAssert.match(
    String(((await call("GET /diagnose")).body as { report: string }).report),
    /turned off in Settings → Plugins/,
  );
  NodeAssert.deepEqual(((await call("GET /config")).body as { servers: string[] }).servers, [
    "atlassian",
  ]);
});
