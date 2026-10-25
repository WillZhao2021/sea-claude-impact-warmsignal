import { daysBetween } from "./scoring";
import { must, type Ctx } from "./supabase";
import type { Contact } from "./types";

// Network momentum: a 0–100 score for how well the user is keeping their network warm, plus a daily
// outreach streak. Deterministic from stored activity + contacts and an eval date, like the briefing.
// Score = 100 × (0.5 Warmth + 0.3 Consistency + 0.2 Giving), every component normalized to 0–1.

export const MOMENTUM_WEIGHTS = { warmth: 0.5, consistency: 0.3, giving: 0.2 } as const;
/** Contacts at or above this strength are their core network; warmth is measured over them. */
export const CORE_STRENGTH = 3;
/** A core contact is warm if the user has spoken with or reached out to them within this many days. */
export const WARM_DAYS = 90;
/** Consistency: active days in the last 14; 10 of 14 (weekdays) earns full marks. */
export const CONSISTENCY_WINDOW = 14;
export const CONSISTENCY_GOAL = 10;
/** Giving: intro steps (asks and intros sent) in the last 30 days; 4 earns full marks. */
export const GIVING_WINDOW = 30;
export const GIVING_GOAL = 4;

export type ActivityKind = "catch_up_sent" | "intro_step" | "note_logged";

export type Momentum = {
  score: number;
  warmth: number;
  consistency: number;
  giving: number;
  coreCount: number;
  warmCount: number;
  activeDays: number;
  introSteps: number;
  streak: number;
  longestStreak: number;
  activeToday: boolean;
  /** Last CONSISTENCY_WINDOW days, oldest first. */
  recent: { date: string; count: number }[];
  /** The weakest component, to suggest what to do next. */
  focus: keyof typeof MOMENTUM_WEIGHTS;
};

export const addDays = (date: string, n: number) =>
  new Date(Date.parse(date) + n * 86_400_000).toISOString().slice(0, 10);

/** Records an outreach action. Never fails the caller: a missed log only costs a streak day. */
export async function logActivity(
  ctx: Ctx,
  kind: ActivityKind,
  date: string,
  refs: { contactId?: string; opportunityId?: string; detail?: string } = {},
) {
  const { error } = await ctx.db.from("activity").insert({
    owner_id: ctx.ownerId,
    date,
    kind,
    detail: refs.detail ?? null,
    contact_id: refs.contactId ?? null,
    opportunity_id: refs.opportunityId ?? null,
  });
  if (error) console.error(`Couldn't log ${kind} activity:`, error.message);
}

/** Consecutive active days ending at `end` (inclusive). */
function runEndingAt(days: Set<string>, end: string): number {
  let n = 0;
  while (days.has(addDays(end, -n))) n++;
  return n;
}

export function computeMomentum(
  contacts: Pick<Contact, "relationship_strength" | "last_interaction_date" | "last_outreach_at">[],
  activity: { date: string; kind: ActivityKind }[],
  evalDate: string,
): Momentum {
  const past = activity.filter((a) => a.date <= evalDate);
  const days = new Set(past.map((a) => a.date));

  // Warmth: share of the core network touched recently. Falls back to everyone if nobody is "core" yet.
  const core = contacts.filter((c) => c.relationship_strength >= CORE_STRENGTH);
  const pool = core.length ? core : contacts;
  const warmCount = pool.filter((c) => {
    const last = [c.last_interaction_date, c.last_outreach_at].filter((d): d is string => !!d && d <= evalDate).sort().at(-1);
    return last != null && daysBetween(last, evalDate) <= WARM_DAYS;
  }).length;
  const warmth = pool.length ? warmCount / pool.length : 0;

  const recent = Array.from({ length: CONSISTENCY_WINDOW }, (_, i) => {
    const date = addDays(evalDate, i - CONSISTENCY_WINDOW + 1);
    return { date, count: past.filter((a) => a.date === date).length };
  });
  const activeDays = recent.filter((d) => d.count > 0).length;
  const consistency = Math.min(1, activeDays / CONSISTENCY_GOAL);

  const introSteps = past.filter((a) => a.kind === "intro_step" && daysBetween(a.date, evalDate) < GIVING_WINDOW).length;
  const giving = Math.min(1, introSteps / GIVING_GOAL);

  // A streak stays alive through today until the day is over: count from yesterday if today is still empty.
  const activeToday = days.has(evalDate);
  const streak = runEndingAt(days, activeToday ? evalDate : addDays(evalDate, -1));
  const longestStreak = Math.max(streak, ...[...days].map((d) => (days.has(addDays(d, 1)) ? 0 : runEndingAt(days, d))));

  const parts = { warmth, consistency, giving };
  const focus = (Object.keys(parts) as (keyof typeof parts)[]).sort(
    (a, b) => MOMENTUM_WEIGHTS[b] * (1 - parts[b]) - MOMENTUM_WEIGHTS[a] * (1 - parts[a]),
  )[0];

  const r = (n: number) => Math.round(n * 1000) / 1000;
  return {
    score: Math.round(100 * (MOMENTUM_WEIGHTS.warmth * warmth + MOMENTUM_WEIGHTS.consistency * consistency + MOMENTUM_WEIGHTS.giving * giving)),
    warmth: r(warmth),
    consistency: r(consistency),
    giving: r(giving),
    coreCount: pool.length,
    warmCount,
    activeDays,
    introSteps,
    streak,
    longestStreak,
    activeToday,
    recent,
    focus,
  };
}

export async function buildMomentum(ctx: Ctx, evalDate: string): Promise<Momentum> {
  const { db, ownerId } = ctx;
  const [contacts, activity] = await Promise.all([
    db
      .from("contacts")
      .select("relationship_strength, last_interaction_date, last_outreach_at")
      .eq("owner_id", ownerId)
      .then((r) => must<Pick<Contact, "relationship_strength" | "last_interaction_date" | "last_outreach_at">[]>(r)),
    db
      .from("activity")
      .select("date, kind")
      .eq("owner_id", ownerId)
      .lte("date", evalDate)
      .gte("date", addDays(evalDate, -365))
      .then((r) => must<{ date: string; kind: ActivityKind }[]>(r)),
  ]);
  return computeMomentum(contacts, activity, evalDate);
}
