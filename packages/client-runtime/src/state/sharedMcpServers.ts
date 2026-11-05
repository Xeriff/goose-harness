import { SharedMcpServer, sharedMcpServerKey } from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

const decodeSharedMcpServer = Schema.decodeUnknownExit(SharedMcpServer);

/**
 * A new server's id: its name, or the name with a suffix when that key is
 * still held by a renamed server. Unique within the list, which is all the
 * secret store needs.
 */
function newSharedMcpServerId(saved: ReadonlyArray<SharedMcpServer>, name: string): string {
  const taken = new Set(saved.map(sharedMcpServerKey));
  let id = name;
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${name}-${suffix}`;
  return id;
}

/** The add/edit form for one shared MCP server, as typed by the user. */
export interface SharedMcpServerDraft {
  readonly name: string;
  readonly url: string;
  /** One `Name: value` header per line. */
  readonly headers: string;
  /** Set for a local program instead of `url`: its command line, quoted like a shell. */
  readonly command?: string;
  /** A local program's environment, one `NAME=value` per line. */
  readonly env?: string;
}

/** Splits a command line into words, honouring single and double quotes. Null when a quote is left open. */
export function splitCommandLine(line: string): ReadonlyArray<string> | null {
  const words: Array<string> = [];
  let word: string | null = null;
  let quote: '"' | "'" | null = null;
  for (const char of line) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else word = (word ?? "") + char;
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= "";
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? "") + char;
    }
  }
  if (quote !== null) return null;
  if (word !== null) words.push(word);
  return words;
}

function formatCommandLine(words: ReadonlyArray<string>): string {
  return words
    .map((word) =>
      word === "" || /[\s"']/.test(word) ? (word.includes('"') ? `'${word}'` : `"${word}"`) : word,
    )
    .join(" ");
}

/**
 * Headers as editable text. Saved values arrive redacted; leaving a line
 * untouched sends the marker back, which keeps the stored value.
 */
function formatSharedMcpServerHeaders(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

/** Draft for editing a saved server. */
export function sharedMcpServerDraft(server: SharedMcpServer): SharedMcpServerDraft {
  return {
    name: server.name,
    url: server.url ?? "",
    headers: formatSharedMcpServerHeaders(server.headers),
    ...(server.command === undefined
      ? {}
      : {
          command: formatCommandLine([server.command, ...server.args]),
          env: Object.entries(server.env)
            .map(([name, value]) => `${name}=${value}`)
            .join("\n"),
        }),
  };
}

/**
 * Validate a draft against the settings schema and the other saved servers.
 * `editing` names the server being replaced, so it may keep its own name.
 */
export function parseSharedMcpServerDraft(
  saved: ReadonlyArray<SharedMcpServer>,
  draft: SharedMcpServerDraft,
  editing?: SharedMcpServer,
): { readonly server: SharedMcpServer } | { readonly error: string } {
  const name = draft.name.trim();
  if (name === "t3-code") return { error: "t3-code is T3 Code's own server." };
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(name)) {
    return { error: "Use up to 24 letters, numbers, dashes, or underscores for the name." };
  }
  if (saved.some((server) => server.name === name && server.name !== editing?.name)) {
    return { error: `A server named ${name} already exists.` };
  }
  // Secrets are stored under the id, so an edit keeps the saved server's
  // (or its name, for an entry saved without one) through a rename.
  const id =
    editing === undefined ? newSharedMcpServerId(saved, name) : sharedMcpServerKey(editing);
  const enabled = editing?.enabled ?? true;
  if (draft.command !== undefined) {
    const words = splitCommandLine(draft.command);
    if (words === null) return { error: "Close the quote in the command." };
    const [command, ...args] = words;
    if (command === undefined) return { error: "Enter the command that starts the server." };
    const env: Record<string, string> = {};
    for (const line of (draft.env ?? "").split("\n")) {
      if (line.trim().length === 0) continue;
      const separator = line.indexOf("=");
      const envName = separator > 0 ? line.slice(0, separator).trim() : "";
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
        return { error: `Write each variable as "NAME=value" (got "${line.trim()}").` };
      }
      if (envName in env) return { error: `${envName} is listed twice.` };
      env[envName] = line.slice(separator + 1);
    }
    const decoded = decodeSharedMcpServer({ id, name, command, args, env, enabled, headers: {} });
    if (Exit.isFailure(decoded)) return { error: "Enter the command that starts the server." };
    return { server: decoded.value };
  }
  const headers: Record<string, string> = {};
  for (const line of draft.headers.split("\n")) {
    if (line.trim().length === 0) continue;
    const separator = line.indexOf(":");
    const headerName = separator > 0 ? line.slice(0, separator).trim() : "";
    if (!/^[A-Za-z0-9-]+$/.test(headerName)) {
      return { error: `Write each header as "Name: value" (got "${line.trim()}").` };
    }
    if (Object.keys(headers).some((name) => name.toLowerCase() === headerName.toLowerCase())) {
      return { error: `The ${headerName} header is listed twice.` };
    }
    headers[headerName] = line.slice(separator + 1).trim();
  }
  const decoded = decodeSharedMcpServer({
    id,
    name,
    url: draft.url.trim(),
    enabled,
    headers,
  });
  if (Exit.isFailure(decoded)) return { error: "Enter an http:// or https:// URL." };
  return { server: decoded.value };
}

/** Replace `editing` (or append) and return the next saved list. */
export function upsertSharedMcpServer(
  saved: ReadonlyArray<SharedMcpServer>,
  server: SharedMcpServer,
  editing?: SharedMcpServer,
): ReadonlyArray<SharedMcpServer> {
  if (editing === undefined) return [...saved, server];
  return saved.map((entry) => (entry.name === editing.name ? server : entry));
}

/** Atlassian's recommended endpoint; the older /v1 ones still answer but expose an older tool set. */
export const ATLASSIAN_MCP_URL = "https://mcp.atlassian.com/v2/mcp";

/** The `Authorization` header Atlassian's MCP takes for an account email and API token. */
export function atlassianBasicAuthHeader(email: string, apiToken: string): string {
  const bytes = new TextEncoder().encode(`${email.trim()}:${apiToken.trim()}`);
  return `Authorization: Basic ${btoa(String.fromCharCode(...bytes))}`;
}

/** The v2 endpoint for a server still on Atlassian's v1 endpoints, or null. */
export function atlassianV2Url(url: string): string | null {
  return /^https:\/\/mcp\.atlassian\.com\/v1(\/|$)/.test(url.trim()) ? ATLASSIAN_MCP_URL : null;
}
