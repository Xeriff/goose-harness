import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { SourceList } from "./service.ts";

export interface SavedList {
  sources: SourceList[];
  /** Epoch ms of the refresh that produced it. */
  at: number;
}

/**
 * The last list the panel showed, kept in memory and on disk
 * (the plugin's data directory), so opening My work shows it at once, even
 * right after the server starts, while a fresh one loads.
 */
export class ListCache {
  private saved: SavedList | undefined;

  private readonly path: string | undefined;

  constructor(path?: string) {
    this.path = path;
    if (!path) return;
    try {
      const loaded = JSON.parse(NodeFS.readFileSync(path, "utf8")) as SavedList;
      if (Array.isArray(loaded?.sources) && typeof loaded.at === "number") this.saved = loaded;
    } catch {
      // First run, or an unreadable file: nothing saved yet.
    }
  }

  get(): SavedList | undefined {
    return this.saved;
  }

  set(saved: SavedList): void {
    this.saved = saved;
    if (!this.path) return;
    NodeFS.mkdirSync(NodePath.dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      NodeFS.writeFileSync(temp, JSON.stringify(saved), { mode: 0o600, flag: "wx" });
      NodeFS.renameSync(temp, this.path);
    } catch {
      // The copy in memory still serves this run.
      NodeFS.rmSync(temp, { force: true });
    }
  }
}
