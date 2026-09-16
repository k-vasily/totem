import { EXERCISES, EXERCISES_BY_ID } from "../data/exercises.js";

/** Resolve the exact ID, catalog name, or case-insensitive catalog name locally. */
export function resolveOfficialExercise(value: string): string | null {
  const trimmed = value.trim();
  if (EXERCISES_BY_ID.has(trimmed)) return trimmed;
  const normalized = trimmed.toLowerCase();
  return EXERCISES.find((exercise) => exercise.name.toLowerCase() === normalized)?.exercise_id ?? null;
}

export interface ExerciseCandidate {
  exercise_id: string;
  name: string;
}

export interface ExerciseResolution {
  /** Set when exactly one catalog entry matches. */
  exercise_id: string | null;
  /** Populated when the input matched several entries (or none) — never guessed. */
  candidates: ExerciseCandidate[];
  match_count: number;
}

/** Collapse an exercise name/ID to space-separated lowercase word tokens. */
function tokenize(value: string): string[] {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

const MAX_CANDIDATES = 12;

/**
 * Resolve a conversational exercise name ("seated row") the way
 * `resolveOfficialExercise` resolves an exact one, but without ever guessing:
 * every input word must appear in the catalog entry's name or ID, and an
 * ambiguous input comes back as candidates for the caller to disambiguate.
 */
export function resolveExerciseOrCandidates(value: string): ExerciseResolution {
  const exact = resolveOfficialExercise(value);
  if (exact) return { exercise_id: exact, candidates: [], match_count: 1 };
  const tokens = tokenize(value);
  if (tokens.length === 0) return { exercise_id: null, candidates: [], match_count: 0 };
  const matches = EXERCISES.filter((exercise) => {
    const haystack = `${tokenize(exercise.name).join(" ")} ${tokenize(exercise.exercise_id).join(" ")}`;
    return tokens.every((token) => haystack.includes(token));
  });
  if (matches.length === 1) {
    return { exercise_id: matches[0]!.exercise_id, candidates: [], match_count: 1 };
  }
  return {
    exercise_id: null,
    candidates: matches.slice(0, MAX_CANDIDATES).map((e) => ({ exercise_id: e.exercise_id, name: e.name })),
    match_count: matches.length,
  };
}
