/**
 * pipeline_feedback — lightweight persistence for agent run feedback.
 *
 * Each agent run produces a `run_id` (uuid generated client-side). The
 * user can:
 *   - rate the result (1 = needs improvement, 2 = good, 3 = excellent)
 *   - or pick a refinement path (more_dynamic / more_natural /
 *     cut_more / manual)
 *
 * Both flow into the same row via upsert on (user_id, run_id), so we
 * can later correlate "how a user felt" with "what they did next".
 */

import { supabase } from "@/integrations/supabase/client";

export type FeedbackRating = 1 | 2 | 3;
export type FeedbackRefinement =
  | "none"
  | "more_dynamic"
  | "more_natural"
  | "cut_more"
  | "manual";

export interface FeedbackPayload {
  runId: string;
  rating?: FeedbackRating | null;
  refinementChoice?: FeedbackRefinement | null;
  versionId?: string | null;
}

export async function saveFeedback(payload: FeedbackPayload): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return; // silent no-op for anonymous sessions

  const row: Record<string, unknown> = {
    user_id: userId,
    run_id: payload.runId,
  };
  if (payload.rating != null) row.rating = payload.rating;
  if (payload.refinementChoice != null) row.refinement_choice = payload.refinementChoice;
  if (payload.versionId != null) row.version_id = payload.versionId;

  const { error } = await supabase
    .from("pipeline_feedback" as never)
    .upsert(row as never, { onConflict: "user_id,run_id" } as never);

  if (error) {
    // non-blocking: feedback is best-effort
    console.warn("[feedback] failed to save", error.message);
  }
}

export interface FeedbackHistoryEntry {
  runId: string;
  rating: FeedbackRating | null;
  refinementChoice: FeedbackRefinement | null;
  versionId: string | null;
  updatedAt: string;
}

export async function listRecentFeedback(limit = 10): Promise<FeedbackHistoryEntry[]> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return [];

  const { data, error } = await supabase
    .from("pipeline_feedback" as never)
    .select("run_id, rating, refinement_choice, version_id, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error || !data) {
    if (error) console.warn("[feedback] failed to list", error.message);
    return [];
  }

  return (data as Array<Record<string, unknown>>).map((row) => ({
    runId: String(row.run_id),
    rating: (row.rating ?? null) as FeedbackRating | null,
    refinementChoice: (row.refinement_choice ?? null) as FeedbackRefinement | null,
    versionId: (row.version_id ?? null) as string | null,
    updatedAt: String(row.updated_at),
  }));
}