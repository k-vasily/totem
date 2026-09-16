import { describe, expect, it } from "vitest";
import { resolveExerciseOrCandidates, resolveOfficialExercise } from "../../src/lib/exercise_lookup.js";

describe("resolveExerciseOrCandidates", () => {
  it("resolves an exact ID and an exact name, like the strict resolver", () => {
    expect(resolveExerciseOrCandidates("SEATEDROW_PULLEYMACHINE").exercise_id).toBe("SEATEDROW_PULLEYMACHINE");
    expect(resolveExerciseOrCandidates("seated Row").exercise_id).toBe("SEATEDROW_PULLEYMACHINE");
    expect(resolveOfficialExercise("bench press")).toBeNull();
  });

  it("resolves a conversational name when exactly one catalog entry matches every word", () => {
    const resolution = resolveExerciseOrCandidates("leg press");
    expect(resolution.exercise_id).toBe("LEGPRESS_PULLEYMACHINE");
    expect(resolution.candidates).toEqual([]);
  });

  it("returns candidates instead of guessing when several entries match", () => {
    const resolution = resolveExerciseOrCandidates("bench press");
    expect(resolution.exercise_id).toBeNull();
    expect(resolution.match_count).toBeGreaterThan(1);
    expect(resolution.candidates.length).toBeGreaterThan(1);
    expect(resolution.candidates.map((c) => c.exercise_id)).toContain("BENCHPRESS_BARBELL");
  });

  it("returns no candidates for an input nothing matches", () => {
    const resolution = resolveExerciseOrCandidates("zercher moon walk");
    expect(resolution.exercise_id).toBeNull();
    expect(resolution.candidates).toEqual([]);
    expect(resolution.match_count).toBe(0);
  });
});
