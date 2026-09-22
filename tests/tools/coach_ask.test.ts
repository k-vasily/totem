import { describe, expect, it, vi } from "vitest";
import type { WhoopClient } from "../../src/whoop/client.js";
import { pollCoachTurn, postCoachTurn } from "../../src/tools/v2/coach_ask.js";
import { WhoopApiError } from "../../src/whoop/errors.js";

describe("pollCoachTurn", () => {
  it("uses a real deadline instead of a fixed iteration count", async () => {
    let now = 0;
    const get = vi.fn().mockResolvedValue({ turn_status: "PENDING", messages: [] });
    const client = { get } as unknown as WhoopClient;
    const result = await pollCoachTurn(client, "conversation", "turn", {
      timeoutMs: 3_000,
      now: () => now,
      sleep: async (ms) => { now += ms; },
      nextDelayMs: () => 1_400,
    });
    expect(result.timedOut).toBe(true);
    expect(now).toBe(3_000);
    expect(result.polled).toBe(2);
  });

  it("returns a complete assistant response immediately on terminal status", async () => {
    let now = 0;
    const client = {
      get: vi.fn().mockResolvedValue({
        turn_status: "COMPLETE",
        messages: [{ role: "assistant", content: "Recovered response" }],
      }),
    } as unknown as WhoopClient;
    const result = await pollCoachTurn(client, "conversation", "turn", {
      timeoutMs: 30_000,
      now: () => now,
      sleep: async (ms) => { now += ms; },
      nextDelayMs: () => 1_000,
    });
    expect(result).toMatchObject({ responseText: "Recovered response", status: "COMPLETE", polled: 1, timedOut: false });
  });
});

// Coach v6.0 regression guards (ClickUp 12418agf1qg).
describe("Coach v6.0 wire shape", () => {
  const v6Turn = {
    turn_status: "COMPLETE",
    messages: [
      { role: "user", items: [{ type: "MARKDOWN_CHAT_TEXT", content: { text: "Name two recovery tips." } }] },
      {
        role: "assistant",
        items: [
          { type: "MARKDOWN_CHAT_TEXT", content: { text: "Two moves:\n" } },
          { type: "MARKDOWN_CHAT_TEXT", content: { text: "\n" } },
          { type: "MARKDOWN_CHAT_TEXT", content: { text: "1. Fix the sleep window.\n" } },
        ],
      },
      { role: "assistant", items: [{ type: "MARKDOWN_CHAT_TEXT", content: { text: "2. No caffeine after 4pm." } }] },
      { role: "assistant", items: [] },
    ],
  };

  it("joins every assistant item across messages instead of truncating to the first", async () => {
    let now = 0;
    const client = { get: vi.fn().mockResolvedValue(v6Turn) } as unknown as WhoopClient;
    const result = await pollCoachTurn(client, "CHAT_WITH_AGENTHOME_2026-09-22_abcd1234", "turn", {
      timeoutMs: 30_000, now: () => now, sleep: async (ms) => { now += ms; }, nextDelayMs: () => 1_000,
    });
    // Pre-v6.0 this returned only "Two moves:\n".
    expect(result.responseText).toBe("Two moves:\n\n1. Fix the sleep window.\n2. No caffeine after 4pm.");
    expect(result.responseText).not.toContain("Name two recovery tips.");
  });

  it("polls the turn under the FINGERPRINT, not the conversation UUID (the 404)", async () => {
    let now = 0;
    const get = vi.fn().mockResolvedValue(v6Turn);
    const client = { get } as unknown as WhoopClient;
    await pollCoachTurn(client, "CHAT_WITH_AGENTHOME_2026-09-22_abcd1234", "t-1", {
      timeoutMs: 30_000, now: () => now, sleep: async (ms) => { now += ms; }, nextDelayMs: () => 1_000,
    });
    expect(get).toHaveBeenCalledWith(
      "/ai-conversation-bff/v1/conversation/CHAT_WITH_AGENTHOME_2026-09-22_abcd1234/turn/t-1",
    );
  });

  it("retries the turn POST while the opening turn is still generating (409)", async () => {
    const post = vi.fn()
      .mockRejectedValueOnce(new WhoopApiError(409, "/turn", "", "Another message is currently being processed"))
      .mockResolvedValueOnce({ id: "turn-1" });
    const client = { post } as unknown as WhoopClient;
    const turn = await postCoachTurn(client, "fp-1", "hi", { sleep: async () => {} });
    expect(turn).toEqual({ id: "turn-1" });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][0]).toBe("/ai-conversation-bff/v1/conversation/fp-1/turn");
  });

  it("does not swallow non-409 failures", async () => {
    const client = {
      post: vi.fn().mockRejectedValue(new WhoopApiError(400, "/turn", "", "bad request")),
    } as unknown as WhoopClient;
    await expect(postCoachTurn(client, "fp-1", "hi", { sleep: async () => {} })).rejects.toThrow("400");
  });
});
