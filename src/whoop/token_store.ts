// Persistence layer for Cognito tokens. The TokenManager writes the rotated
// access + refresh tokens after every refresh so server restarts pick up the
// latest state without re-bootstrapping (until the refresh token itself
// expires, ~30 days).
//
// Two implementations:
//   - EnvFileTokenStore: writes to a .env file. Used in local dev and on any
//     host that lets you persist a small file (Fly volumes, Railway disks,
//     a VPS). The default.
//   - MemoryTokenStore: no persistence. Used on hosts with read-only file
//     systems (Cloudflare Workers, read-only container disks). Accept that you'll
//     re-bootstrap every 30 days. Opt in via WHOOP_TOKEN_STORE=memory.
//
// Several processes share one EnvFileTokenStore (a long-lived MCP server plus
// short-lived headless callers spawned per cron tick). So the file store also
// offers `load()` (re-read what a sibling process may have written) and
// `withLock()` (an O_EXCL lock file next to the .env) so only one process at a
// time spends the refresh token, and writes are atomic (.tmp + rename) so a
// reader never sees a half-written file.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  renameSync,
  openSync,
  closeSync,
  writeSync,
  unlinkSync,
  statSync,
  fsyncSync,
} from "node:fs";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
}

export interface TokenStore {
  save(updates: StoredTokens): void;
  /** Re-read tokens persisted by any process. Null when the store cannot tell. */
  load?(): StoredTokens | null;
  /** Run `fn` while holding a cross-process lock on the store. */
  withLock?<T>(fn: () => Promise<T>): Promise<T>;
}

const ACCESS_KEY = "WHOOP_IOS_BEARER_TOKEN";
const REFRESH_KEY = "WHOOP_COGNITO_REFRESH_TOKEN";

function parseValue(line: string, key: string): string | null {
  if (!line.startsWith(`${key}=`)) return null;
  let v = line.slice(key.length + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

export interface EnvFileTokenStoreOptions {
  /** Max time to wait for another process's lock. Default 45s (> one Cognito call). */
  lockWaitMs?: number;
  /** A lock older than this is treated as abandoned. Default 120s. */
  lockStaleMs?: number;
}

export class EnvFileTokenStore implements TokenStore {
  private readonly lockPath: string;
  private readonly lockWaitMs: number;
  private readonly lockStaleMs: number;

  constructor(private path: string, options: EnvFileTokenStoreOptions = {}) {
    this.lockPath = `${path}.refresh.lock`;
    this.lockWaitMs = options.lockWaitMs ?? 45_000;
    this.lockStaleMs = options.lockStaleMs ?? 120_000;
  }

  load(): StoredTokens | null {
    if (!existsSync(this.path)) return null;
    let access: string | null = null;
    let refresh: string | null = null;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      access = parseValue(line, ACCESS_KEY) ?? access;
      refresh = parseValue(line, REFRESH_KEY) ?? refresh;
    }
    if (!access || !refresh) return null;
    return { accessToken: access, refreshToken: refresh };
  }

  save(updates: StoredTokens): void {
    if (!existsSync(this.path)) return;
    const lines = readFileSync(this.path, "utf8").split("\n");
    const upsert = (key: string, value: string): void => {
      const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
      const entry = `${key}=${value}`;
      if (idx >= 0) lines[idx] = entry;
      else lines.push(entry);
    };
    upsert(ACCESS_KEY, updates.accessToken);
    upsert(REFRESH_KEY, updates.refreshToken);
    // Atomic replace: write a 0600 sibling, fsync, rename over the original.
    // A concurrent reader sees either the old file or the new one, never a
    // truncated one. 0600: this file holds the refresh token.
    const tmp = `${this.path}.tmp.${process.pid}`;
    try {
      writeFileSync(tmp, lines.join("\n"), { mode: 0o600 });
      try { chmodSync(tmp, 0o600); } catch { /* best-effort on exotic FS */ }
      const fd = openSync(tmp, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, this.path);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* already gone */ }
      throw error;
    }
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      try { unlinkSync(this.lockPath); } catch { /* already gone */ }
    }
  }

  private async acquire(): Promise<void> {
    const deadline = Date.now() + this.lockWaitMs;
    for (;;) {
      try {
        const fd = openSync(this.lockPath, "wx", 0o600); // O_CREAT | O_EXCL
        try { writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`); } finally { closeSync(fd); }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (this.isAbandoned()) {
        try { unlinkSync(this.lockPath); } catch { /* raced with another breaker */ }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`token store lock ${this.lockPath} held by another process for over ${this.lockWaitMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Stale by age, or its owner pid no longer exists. */
  private isAbandoned(): boolean {
    try {
      const st = statSync(this.lockPath);
      if (Date.now() - st.mtimeMs > this.lockStaleMs) return true;
      const pid = Number(readFileSync(this.lockPath, "utf8").split(" ")[0]);
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
        }
      }
      return false;
    } catch {
      return false; // vanished between EEXIST and stat — just retry
    }
  }
}

export class MemoryTokenStore implements TokenStore {
  save(_updates: StoredTokens): void {
    // intentionally no-op; tokens persist only for the lifetime of this process
  }
}
