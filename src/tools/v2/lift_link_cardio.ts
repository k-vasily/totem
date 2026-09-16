import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhoopClient } from "../../whoop/client.js";
import { LiftLinkCardioOut } from "../../schemas/strength.js";
import { preview } from "../../whoop/write_safety.js";
import { WhoopApiError, WhoopProjectionError, apiErrorDetail } from "../../whoop/errors.js";
import { jsonOut } from "../../whoop/json_out.js";
import { buildExerciseGroups, buildLinkExerciseGroups, type InputExercise } from "../../whoop/build_lift_body.js";
import { resolveExerciseOrCandidates } from "../../lib/exercise_lookup.js";
import { isObject, asString, asNumber } from "../../lib/walk.js";

// This is the endpoint behind the app's "Calculate Muscular Load" option
// (LINK_MSK_WORKOUT) on a strap-tracked activity. Unlike
// .../weightlifting-workout/activity — which CREATES a new Strength Trainer
// activity — it ATTACHES set-by-set strength data to an activity that already
// exists, so the one activity carries both the HR/cardio strain and the computed
// Muscular Load. The activity then reports as weightlifting_msk.
//
// Two calls, mirroring iOS: save a template, then link it to the activity.
const TEMPLATE_PATH = "/weightlifting-service/v3/workout-template";
const PATH = "/weightlifting-service/v2/weightlifting-workout/link-cardio-workout";

export function registerLiftLinkCardio(server: McpServer, client: WhoopClient): void {
  server.tool(
    "whoop_lift_link_cardio",
    "WRITE: attach set-by-set strength data to an EXISTING activity (the app's \"Calculate Muscular Load\"), so that activity carries both its cardio strain and Muscular Load — it does not create a new activity (use whoop_lift_log for that). Exercises take an ID or a name (conversational names are resolved against the bundled catalog; an ambiguous name comes back as candidates). Preview unless confirm:true.",
    {
      activity_id: z.string().min(1).describe("ID of the already-recorded activity to attach the lift to (e.g. from whoop_workouts)."),
      name: z.string().optional().describe("Template name; defaults to today's date."),
      exercises: z.array(z.object({
        exercise_id: z.string().optional(),
        exercise: z.string().optional().describe("Exercise ID, exact catalog name, or a conversational name like \"seated row\"."),
        sets: z.array(z.object({
          reps: z.number().int().min(0),
          weight: z.number().min(0).optional().describe("Weight in kg."),
          time_seconds: z.number().int().min(0).optional().describe("Only for TIME-format exercises (e.g. Assault Bike)."),
        })).min(1),
      })).min(1),
      rpe: z.number().min(0).max(10).default(0).describe("Rate of perceived exertion; the app sends 0."),
      confirm: z.boolean().default(false),
    },
    async ({ activity_id, name, exercises, rpe, confirm }) => {
      // Resolve names locally before anything fires. Ambiguity is reported with
      // candidates rather than silently taking the first match.
      const resolved: InputExercise[] = [];
      const ambiguous: Array<Record<string, unknown>> = [];
      const unresolved: string[] = [];
      for (const exercise of exercises) {
        const sets = exercise.sets.map((s) => ({ reps: s.reps, weight: s.weight, time_seconds: s.time_seconds }));
        if (exercise.exercise_id) {
          resolved.push({ exercise_id: exercise.exercise_id, sets });
          continue;
        }
        if (!exercise.exercise) {
          unresolved.push("(missing exercise_id and exercise)");
          continue;
        }
        const match = resolveExerciseOrCandidates(exercise.exercise);
        if (match.exercise_id) {
          resolved.push({ exercise_id: match.exercise_id, sets });
          continue;
        }
        if (match.candidates.length > 0) {
          ambiguous.push({ input: exercise.exercise, match_count: match.match_count, candidates: match.candidates });
        } else {
          unresolved.push(exercise.exercise);
        }
      }
      if (ambiguous.length > 0) {
        return {
          content: [{ type: "text", text: jsonOut({
            error: "Ambiguous exercise name — pass exercise_id (or a more specific name) for each.",
            ambiguous,
            hint: "Use whoop_lift_catalog to search the full catalog.",
          }) }],
          isError: true,
        };
      }
      if (unresolved.length > 0) {
        return {
          content: [{ type: "text", text: jsonOut({
            error: "Unknown exercise name — nothing in the bundled catalog matched.",
            unresolved,
            hint: "Use whoop_lift_catalog or whoop_lift_custom_exercise",
          }) }],
          isError: true,
        };
      }

      // The inline template in the link body uses the simple set shape
      // ({weight, number_of_reps}); the step-1 template POST uses the same body
      // shape whoop_lift_template_save sends.
      const linkBuild = buildLinkExerciseGroups(resolved);
      if (linkBuild.unknown_exercises.length > 0) {
        return {
          content: [{ type: "text", text: jsonOut({
            error: "Unknown exercise IDs",
            unknown_exercises: linkBuild.unknown_exercises,
            hint: "Use whoop_lift_catalog or whoop_lift_custom_exercise",
          }) }],
          isError: true,
        };
      }
      const templateName = name ?? new Date().toISOString().slice(0, 10);
      const templateBody = { name: templateName, workout_groups: buildExerciseGroups(resolved, Date.now()).workout_groups };

      if (!confirm) {
        return {
          content: [{ type: "text", text: jsonOut(preview("POST", PATH, {
            activity_id,
            template_name: templateName,
            rpe,
            exercise_count: resolved.length,
            set_count: linkBuild.set_count,
            exercise_list: resolved.map((e) => ({ exercise_id: e.exercise_id, set_count: e.sets.length })),
            first_call: `POST ${TEMPLATE_PATH}`,
          })) }],
        };
      }

      let templateId: number | null = null;
      try {
        const templateReceipt = await client.post<unknown>(TEMPLATE_PATH, templateBody);
        const root = isObject(templateReceipt) ? templateReceipt : {};
        templateId = asNumber(root.workout_template_key ?? root.id);
      } catch (error) {
        if (error instanceof WhoopApiError) {
          return {
            content: [{ type: "text", text: jsonOut({
              error: "WHOOP rejected the workout template; nothing was linked.",
              status: error.status,
              endpoint: TEMPLATE_PATH,
              reason: apiErrorDetail(error.body) ?? null,
            }) }],
            isError: true,
          };
        }
        throw error;
      }
      if (templateId === null) {
        return {
          content: [{ type: "text", text: jsonOut({
            error: "WHOOP saved the template without returning a workout_template_key; nothing was linked.",
            endpoint: TEMPLATE_PATH,
          }) }],
          isError: true,
        };
      }

      const linkBody = {
        template: {
          workout_groups: linkBuild.workout_groups,
          name: templateName,
          source: "USER",
          workout_template_key: templateId,
        },
        rpe,
        template_id: templateId,
        activity_id,
      };
      let receipt: unknown;
      try {
        receipt = await client.post<unknown>(PATH, linkBody);
      } catch (error) {
        if (error instanceof WhoopApiError) {
          return {
            content: [{ type: "text", text: jsonOut({
              error: "WHOOP rejected the link; the template was saved but no activity was changed.",
              status: error.status,
              endpoint: PATH,
              template_id: templateId,
              reason: apiErrorDetail(error.body) ?? null,
              hint: "Check that activity_id exists and that the app offers \"Calculate Muscular Load\" on it (link_workout_option_enabled in cardio-details).",
            }) }],
            isError: true,
          };
        }
        throw error;
      }

      // Success proof: the response's workout_metadata is the now-linked
      // activity, carrying a fresh weightlifting_workout_id and the computed
      // volume / Muscular Load.
      const root = isObject(receipt) ? receipt : {};
      const metadata = isObject(root.workout_metadata) ? root.workout_metadata : {};
      const liftId = asString(metadata.weightlifting_workout_id);
      const linkedActivityId = asString(root.original_activity_id) ?? asString(metadata.id) ?? activity_id;
      const projected = {
        linked: true as const,
        activity_id: linkedActivityId,
        activity_type: asString(root.original_activity_type) ?? asString(metadata.type),
        template_id: asNumber(metadata.workout_template_id) ?? templateId,
        weightlifting_workout_id: liftId,
        exercise_count: resolved.length,
        set_count: linkBuild.set_count,
        total_volume_kg: asNumber(metadata.total_effective_volume_kg),
        msk_intensity_percent: asNumber(metadata.msk_intensity_percent),
        scaled_msk_strain_score: asNumber(metadata.scaled_msk_strain_score),
        verified: liftId !== null && linkedActivityId === activity_id,
      };
      try {
        const out = LiftLinkCardioOut.parse(projected);
        return { content: [{ type: "text", text: jsonOut(out) }] };
      } catch (e) {
        if (e instanceof z.ZodError) throw new WhoopProjectionError("whoop_lift_link_cardio", e);
        throw e;
      }
    },
  );
}
