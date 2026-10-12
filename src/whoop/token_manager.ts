// Holds the current access token + refresh token, auto-refreshes via Cognito
// when the access token is within `refreshSkewSeconds` of expiry, and on
// demand (`forceRefresh`) when WHOOP answers 401 before that expiry. Writes
// rotated tokens to an injected TokenStore so server restarts pick up fresh
// state without re-bootstrapping.
import { decodeJwtExp, refreshCognitoSession } from "./cognito.js";
import { EnvFileTokenStore, type TokenStore } from "./token_store.js";

/** Minimum spacing between two 401-driven refreshes in one process. */
const FORCED_REFRESH_COOLDOWN_MS = 30_000;

export interface TokenManagerConfig {
  email: string;
  accessToken: string;
  refreshToken: string;
  /** How many seconds before exp to preemptively refresh. Default 60. */
  refreshSkewSeconds?: number;
  /**
   * Where to persist rotated tokens. Pass `EnvFileTokenStore(path)` (default
   * when `envPath` is given) or `MemoryTokenStore` for ephemeral hosts.
   */
  store?: TokenStore;
  /** Convenience: provide envPath instead of `store` to get the default file store. */
  envPath?: string;
}

export class TokenManager {
  private email: string;
  private accessToken: string;
  private refreshToken: string;
  private expiresAt: number; // epoch ms
  private skewMs: number;
  private store: TokenStore;
  private refreshing: Promise<void> | null = null;
  private lastRefreshAt = 0;

  constructor(config: TokenManagerConfig) {
    this.email = config.email;
    this.accessToken = config.accessToken;
    this.refreshToken = config.refreshToken;
    this.skewMs = (config.refreshSkewSeconds ?? 60) * 1000;
    this.expiresAt = decodeJwtExp(config.accessToken) * 1000;
    if (config.store) {
      this.store = config.store;
    } else if (config.envPath) {
      this.store = new EnvFileTokenStore(config.envPath);
    } else {
      throw new Error("TokenManager: pass either `store` or `envPath`");
    }
  }

  async getToken(): Promise<string> {
    if (this.isFresh()) return this.accessToken;
    return this.singleFlight(null);
  }

  /**
   * WHOOP rejected `rejectedToken` with 401 even though its `exp` says it is
   * still valid (server-side revocation happens). Refresh once and return the
   * new token. Returns `rejectedToken` unchanged when no new token could be
   * obtained without hammering Cognito — the caller then surfaces the 401.
   */
  async forceRefresh(rejectedToken: string): Promise<string> {
    // Another request in this process already replaced it.
    if (this.accessToken !== rejectedToken) return this.accessToken;
    return this.singleFlight(rejectedToken);
  }

  private async singleFlight(rejected: string | null): Promise<string> {
    // Single-flight: if a refresh is already running, wait on it
    if (!this.refreshing) {
      this.refreshing = this.refreshShared(rejected).finally(() => {
        this.refreshing = null;
      });
    }
    await this.refreshing;
    return this.accessToken;
  }

  /**
   * Refresh under the store's cross-process lock. Several processes share one
   * token file (the long-lived MCP server and per-tick headless callers); if a
   * sibling refreshed while we waited for the lock, adopt its tokens instead of
   * spending the refresh token a second time.
   */
  private async refreshShared(rejected: string | null): Promise<void> {
    const run = async (): Promise<void> => {
      const disk = this.store.load?.() ?? null;
      if (disk) {
        if (disk.accessToken !== this.accessToken && disk.accessToken !== rejected) {
          const exp = decodeJwtExp(disk.accessToken) * 1000;
          if (Date.now() < exp - this.skewMs) {
            this.accessToken = disk.accessToken;
            this.refreshToken = disk.refreshToken;
            this.expiresAt = exp;
            return;
          }
        }
        // The file holds the newest refresh token (it may have been rotated
        // by a sibling); spend that one, not our possibly stale copy.
        this.refreshToken = disk.refreshToken;
      }
      // A token we minted moments ago being rejected again is not an expiry
      // problem; refreshing in a loop would only burn Cognito calls.
      if (rejected !== null && Date.now() - this.lastRefreshAt < FORCED_REFRESH_COOLDOWN_MS) return;
      await this.doRefresh();
    };
    if (this.store.withLock) await this.store.withLock(run);
    else await run();
  }

  private isFresh(): boolean {
    return Date.now() < this.expiresAt - this.skewMs;
  }

  private async doRefresh(): Promise<void> {
    const next = await refreshCognitoSession(this.email, this.refreshToken);
    this.accessToken = next.accessToken;
    // Cognito may rotate the refresh token; if it does, persist the new one.
    if (next.refreshToken && next.refreshToken !== this.refreshToken) {
      this.refreshToken = next.refreshToken;
      // Observable so a memory-store (non-persisting) deploy can tell when a
      // restart would strand the old token. See SECURITY.md → token hygiene.
      console.error("[totem] Cognito rotated the refresh token — persisting the new one.");
    }
    this.expiresAt = next.expiresAt;
    this.lastRefreshAt = Date.now();
    try {
      this.store.save({ accessToken: this.accessToken, refreshToken: this.refreshToken });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[totem] refreshed the Whoop access token but could not persist it: ${detail}. This process will keep using the fresh in-memory token.`);
    }
  }
}
