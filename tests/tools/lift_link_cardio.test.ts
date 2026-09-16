import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../src/whoop/client.js";
import { registerLiftLinkCardio } from "../../src/tools/v2/lift_link_cardio.js";
import { WhoopApiError } from "../../src/whoop/errors.js";

const TEMPLATE_PATH = "/weightlifting-service/v3/workout-template";
const LINK_PATH = "/weightlifting-service/v2/weightlifting-workout/link-cardio-workout";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function connect(register: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: "test-server", version: "1" });
  register(server);
  const client = new Client({ name: "test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

function textOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text);
}

function linkReceipt(activityId = "activity-1") {
  return {
    original_activity_id: activityId,
    original_activity_type: "weightlifting",
    workout_metadata: {
      id: activityId,
      during: "['2026-07-20T16:36:34.972Z','2026-07-20T18:09:29.181Z')",
      score_type: "CARDIO",
      type: "weightlifting",
      weightlifting_workout_id: "3fbd0a2e-0000-4000-8000-000000000001",
      workout_template_id: 987,
      total_effective_volume_kg: 141.65,
      raw_msk_strain_score: 0.00199,
      msk_intensity_percent: 0.4,
      scaled_msk_strain_score: 0.197,
    },
  };
}

/** Mock that answers the template POST first, then the link POST. */
function postMock(receipt: unknown = linkReceipt(), templateKey: unknown = { workout_template_key: 987 }) {
  return vi.fn().mockImplementation(async (path: string) => {
    if (path === TEMPLATE_PATH) return templateKey;
    if (path === LINK_PATH) return receipt;
    throw new Error(`unexpected path ${path}`);
  });
}

const ARGS = {
  activity_id: "activity-1",
  name: "20 Jul 2026",
  exercises: [
    { exercise: "seated row", sets: [{ weight: 40, reps: 8 }, { weight: 40, reps: 8 }] },
  ],
};

describe("whoop_lift_link_cardio through MCP", () => {
  it("previews without mutating, then runs the two-call template + link sequence", async () => {
    const post = postMock();
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => registerLiftLinkCardio(server, whoop));

    const preview = await client.callTool({ name: "whoop_lift_link_cardio", arguments: ARGS });
    expect(preview.isError).not.toBe(true);
    expect(post).not.toHaveBeenCalled();
    expect(textOf(preview)).toMatchObject({
      preview: true,
      will_execute: { method: "POST", path: LINK_PATH },
    });

    const result = await client.callTool({ name: "whoop_lift_link_cardio", arguments: { ...ARGS, confirm: true } });
    expect(result.isError).not.toBe(true);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]?.[0]).toBe(TEMPLATE_PATH);
    expect(post.mock.calls[1]?.[0]).toBe(LINK_PATH);
    expect(textOf(result)).toMatchObject({
      linked: true,
      activity_id: "activity-1",
      activity_type: "weightlifting",
      template_id: 987,
      weightlifting_workout_id: "3fbd0a2e-0000-4000-8000-000000000001",
      exercise_count: 1,
      set_count: 2,
      total_volume_kg: 141.65,
      scaled_msk_strain_score: 0.197,
      verified: true,
    });
  });

  it("builds the link body with the simple set shape, the template key and the activity id", async () => {
    const post = postMock();
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => registerLiftLinkCardio(server, whoop));
    await client.callTool({ name: "whoop_lift_link_cardio", arguments: { ...ARGS, confirm: true } });

    const body = post.mock.calls[1]?.[1] as {
      template: { name: string; source: string; workout_template_key: number; workout_groups: Array<{ workout_exercises: Array<{ sets: Array<Record<string, unknown>>; exercise_details: Record<string, unknown> }> }> };
      rpe: number;
      template_id: number;
      activity_id: string;
    };
    expect(body.activity_id).toBe("activity-1");
    expect(body.template_id).toBe(987);
    expect(body.rpe).toBe(0);
    expect(body.template).toMatchObject({ name: "20 Jul 2026", source: "USER", workout_template_key: 987 });

    const exercise = body.template.workout_groups[0]!.workout_exercises[0]!;
    // Name resolved conversationally against the bundled catalog.
    expect(exercise.exercise_details).toMatchObject({ exercise_id: "SEATEDROW_PULLEYMACHINE", name: "Seated Row" });
    // created_at/updated_at must be non-empty or WHOOP 422s silently.
    expect(exercise.exercise_details.created_at).toBeTruthy();
    expect(exercise.exercise_details.updated_at).toBeTruthy();
    // Simple set shape only — no `during`, no set UUID, no strap_location.
    expect(exercise.sets).toEqual([
      { weight: 40, number_of_reps: 8 },
      { weight: 40, number_of_reps: 8 },
    ]);
  });

  it("keeps time_in_seconds for TIME-format exercises", async () => {
    const post = postMock();
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => registerLiftLinkCardio(server, whoop));
    await client.callTool({
      name: "whoop_lift_link_cardio",
      arguments: {
        activity_id: "activity-1",
        exercises: [{ exercise_id: "ASSAULT_AIRBIKE", sets: [{ reps: 0, time_seconds: 90 }] }],
        confirm: true,
      },
    });
    const body = post.mock.calls[1]?.[1] as { template: { workout_groups: Array<{ workout_exercises: Array<{ sets: Array<Record<string, unknown>> }> }> } };
    expect(body.template.workout_groups[0]!.workout_exercises[0]!.sets[0]).toEqual({
      weight: 0,
      number_of_reps: 0,
      time_in_seconds: 90,
    });
  });

  it("refuses an ambiguous exercise name with candidates instead of guessing", async () => {
    const post = postMock();
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => registerLiftLinkCardio(server, whoop));
    const result = await client.callTool({
      name: "whoop_lift_link_cardio",
      arguments: { activity_id: "activity-1", exercises: [{ exercise: "bench press", sets: [{ weight: 60, reps: 5 }] }], confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(post).not.toHaveBeenCalled();
    const payload = textOf(result) as { ambiguous: Array<{ input: string; match_count: number; candidates: Array<{ exercise_id: string }> }> };
    expect(payload.ambiguous[0]?.input).toBe("bench press");
    expect(payload.ambiguous[0]!.match_count).toBeGreaterThan(1);
    expect(payload.ambiguous[0]!.candidates.map((c) => c.exercise_id)).toContain("BENCHPRESS_BARBELL");
  });

  it("rejects an unknown exercise name without mutating", async () => {
    const post = postMock();
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => registerLiftLinkCardio(server, whoop));
    const result = await client.callTool({
      name: "whoop_lift_link_cardio",
      arguments: { activity_id: "activity-1", exercises: [{ exercise: "zercher moon walk", sets: [{ reps: 5 }] }], confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(post).not.toHaveBeenCalled();
    expect(JSON.stringify(result.content)).toContain("Unknown exercise name");
  });

  it("rejects an unknown exercise_id without mutating", async () => {
    const post = postMock();
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => registerLiftLinkCardio(server, whoop));
    const result = await client.callTool({
      name: "whoop_lift_link_cardio",
      arguments: { activity_id: "activity-1", exercises: [{ exercise_id: "NOT_A_REAL_EXERCISE", sets: [{ reps: 5 }] }], confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(post).not.toHaveBeenCalled();
    expect(JSON.stringify(result.content)).toContain("Unknown exercise IDs");
  });

  it("does not attempt the link when the template POST returns no key", async () => {
    const post = postMock(linkReceipt(), {});
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => registerLiftLinkCardio(server, whoop));
    const result = await client.callTool({ name: "whoop_lift_link_cardio", arguments: { ...ARGS, confirm: true } });
    expect(result.isError).toBe(true);
    expect(post).toHaveBeenCalledOnce();
    expect(JSON.stringify(result.content)).toContain("workout_template_key");
  });

  it("surfaces a structured WHOOP rejection of the link call", async () => {
    const post = vi.fn().mockImplementation(async (path: string) => {
      if (path === TEMPLATE_PATH) return { workout_template_key: 987 };
      throw new WhoopApiError(422, LINK_PATH, JSON.stringify({ message: "activity not linkable" }), "activity not linkable");
    });
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => registerLiftLinkCardio(server, whoop));
    const result = await client.callTool({ name: "whoop_lift_link_cardio", arguments: { ...ARGS, confirm: true } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("activity not linkable");
    expect(textOf(result)).toMatchObject({ status: 422, template_id: 987 });
  });

  it("reports verified:false when the response carries no weightlifting_workout_id", async () => {
    const receipt = linkReceipt();
    delete (receipt.workout_metadata as Record<string, unknown>).weightlifting_workout_id;
    const post = postMock(receipt);
    const whoop = { post } as unknown as WhoopClient;
    const client = await connect((server) => registerLiftLinkCardio(server, whoop));
    const result = await client.callTool({ name: "whoop_lift_link_cardio", arguments: { ...ARGS, confirm: true } });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toMatchObject({ linked: true, weightlifting_workout_id: null, verified: false });
  });
});
