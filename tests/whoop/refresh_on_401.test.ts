// Refresh-on-401: WHOOP can revoke an access token before its `exp`. The client
// must refresh once and retry; a second 401 is still a hard auth error, and
// sibling processes sharing the token file must not spend the refresh token twice.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const refreshMock = vi.fn();
vi.mock("../../src/whoop/cognito.js", () => ({
  // tokens in these tests look like "<name>.<exp-seconds>"
  decodeJwtExp: (jwt: string) => Number(jwt.split(".")[1] ?? 0),
  refreshCognitoSession: (...args: unknown[]) => refreshMock(...args),
}));

import { WhoopClient } from "../../src/whoop/client.js";
import { TokenManager } from "../../src/whoop/token_manager.js";
import { EnvFileTokenStore } from "../../src/whoop/token_store.js";
import { WhoopAuthExpiredError } from "../../src/whoop/errors.js";

const fetchMock = vi.fn();
const future = () => Math.floor(Date.now() / 1000) + 3600;
const tok = (name: string) => `${name}.${future()}`;

function envFile(access: string, refresh: string): string {
  const dir = mkdtempSync(join(tmpdir(), "totem-401-"));
  const p = join(dir, ".env");
  writeFileSync(p, `WHOOP_EMAIL=a@b.c\nWHOOP_IOS_BEARER_TOKEN=${access}\nWHOOP_COGNITO_REFRESH_TOKEN=${refresh}\nOTHER=keep\n`, { mode: 0o600 });
  return p;
}

function setup(path: string, access: string, refresh: string) {
  const tm = new TokenManager({ email: "a@b.c", accessToken: access, refreshToken: refresh, store: new EnvFileTokenStore(path) });
  const client = new WhoopClient({ getToken: () => tm.getToken(), onUnauthorized: (r) => tm.forceRefresh(r) });
  return { tm, client };
}

const bearer = (call: unknown[]) => ((call[1] as RequestInit).headers as Record<string, string>).authorization;

beforeEach(() => {
  fetchMock.mockReset();
  refreshMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("refresh on 401", () => {
  it("refreshes once, persists atomically with 0600, and retries the request", async () => {
    const revoked = tok("revoked");
    const fresh = tok("fresh");
    const path = envFile(revoked, "rt-1");
    refreshMock.mockResolvedValueOnce({ accessToken: fresh, refreshToken: "rt-2", idToken: "i", expiresAt: Date.now() + 3_600_000 });
    fetchMock
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ records: [1] }), { status: 200 }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { client } = setup(path, revoked, "rt-1");
    await expect(client.post("/x", {})).resolves.toEqual({ records: [1] });

    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(refreshMock.mock.calls[0]![1]).toBe("rt-1");
    expect(bearer(fetchMock.mock.calls[0]!)).toBe(`Bearer ${revoked}`);
    expect(bearer(fetchMock.mock.calls[1]!)).toBe(`Bearer ${fresh}`);
    const text = readFileSync(path, "utf8");
    expect(text).toContain(`WHOOP_IOS_BEARER_TOKEN=${fresh}`);
    expect(text).toContain("WHOOP_COGNITO_REFRESH_TOKEN=rt-2");
    expect(text).toContain("OTHER=keep");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.refresh.lock`)).toBe(false);
    expect(readdirSync(join(path, "..")).filter((f) => f.includes(".tmp."))).toEqual([]);
  });

  it("a second 401 after the refresh is still WhoopAuthExpiredError", async () => {
    const path = envFile(tok("revoked"), "rt-1");
    refreshMock.mockResolvedValueOnce({ accessToken: tok("fresh"), refreshToken: "rt-1", idToken: "i", expiresAt: Date.now() + 3_600_000 });
    fetchMock.mockImplementation(async () => new Response("unauthorized", { status: 401 }));
    const { client } = setup(path, tok("revoked"), "rt-1");
    await expect(client.get("/y")).rejects.toBeInstanceOf(WhoopAuthExpiredError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    // Cooldown: an immediate repeat does not hit Cognito again.
    await expect(client.get("/y2")).rejects.toBeInstanceOf(WhoopAuthExpiredError);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("adopts a token a sibling process already wrote instead of spending the refresh token", async () => {
    const revoked = tok("revoked");
    const sibling = tok("sibling");
    const path = envFile(revoked, "rt-1");
    const { client } = setup(path, revoked, "rt-1");
    // sibling process refreshes and rotates the refresh token on disk
    new EnvFileTokenStore(path).save({ accessToken: sibling, refreshToken: "rt-2" });
    fetchMock
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await expect(client.get("/z")).resolves.toEqual({});
    expect(refreshMock).not.toHaveBeenCalled();
    expect(bearer(fetchMock.mock.calls[1]!)).toBe(`Bearer ${sibling}`);
  });

  it("concurrent 401s in two processes refresh exactly once (O_EXCL lock)", async () => {
    const revoked = tok("revoked");
    const fresh = tok("fresh");
    const path = envFile(revoked, "rt-1");
    // two independent managers = two processes sharing one file
    const a = setup(path, revoked, "rt-1");
    const b = setup(path, revoked, "rt-1");
    refreshMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 150));
      return { accessToken: fresh, refreshToken: "rt-2", idToken: "i", expiresAt: Date.now() + 3_600_000 };
    });
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
      (init.headers as Record<string, string>).authorization === `Bearer ${revoked}`
        ? new Response("unauthorized", { status: 401 })
        : new Response("{}", { status: 200 }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(Promise.all([a.client.post("/p", {}), b.client.post("/q", {})])).resolves.toEqual([{}, {}]);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("without onUnauthorized a 401 is thrown as before", async () => {
    fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    const client = new WhoopClient({ getToken: async () => "t" });
    await expect(client.get("/w")).rejects.toBeInstanceOf(WhoopAuthExpiredError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("EnvFileTokenStore lock", () => {
  it("breaks a lock left by a dead process", async () => {
    const path = envFile("a.1", "r");
    writeFileSync(`${path}.refresh.lock`, "999999999 2026-01-01T00:00:00Z\n");
    const store = new EnvFileTokenStore(path, { lockWaitMs: 2000 });
    await expect(store.withLock(async () => "ok")).resolves.toBe("ok");
    expect(existsSync(`${path}.refresh.lock`)).toBe(false);
  });

  it("waits for a live holder and times out instead of refreshing concurrently", async () => {
    const path = envFile("a.1", "r");
    writeFileSync(`${path}.refresh.lock`, `${process.pid} now\n`);
    const store = new EnvFileTokenStore(path, { lockWaitMs: 300 });
    await expect(store.withLock(async () => "ok")).rejects.toThrow(/held by another process/);
  });
});
