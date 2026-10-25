import { buildBriefing, type Briefing } from "./briefing";
import { activeSignals, ASK_MIN_STRENGTH, askPotential, bestAsk, goalFit, type SignalRow } from "./fit";
import { addDays, type ActivityKind } from "./momentum";
import { DEFAULT_PROFILE, type Profile } from "./profile";
import { must, type Ctx } from "./supabase";
import type { Contact } from "./types";
import { profileFit, type ProfileFit } from "./vectors";

// Give / Ask: the next move with each contact. Ask only when there's a case for asking (they fit the
// user's goal or could give them something, fit.ts), the relationship can carry it, and the weekly
// ask budget is open: "Asks per week, at most" caps it, and "Give before you ask" unlocks one ask per
// N gives (intro steps and catch-ups sent) this week. Otherwise, give.

export type MoveKind = "give" | "ask";
export type Move = { kind: MoveKind; why: string };

/** Strength of the case for asking (0–1) needed before the tag says Ask. */
export const ASK_MIN_SCORE = 0.5;

type ActivityRow = { date: string; kind: ActivityKind; detail: string | null };

export type AskBudget = {
  asksPerWeek: number;
  givesPerAsk: number;
  gives: number;
  asks: number;
  /** Asks available right now. */
  open: number;
  /** Gives still needed to unlock the next ask (0 if one is open or the weekly cap is reached). */
  givesToUnlock: number;
};

const isAsk = (a: ActivityRow) => a.detail === "ask";
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Monday of evalDate's week. */
export function weekStart(evalDate: string): string {
  const dow = new Date(evalDate + "T12:00:00Z").getUTCDay();
  return addDays(evalDate, -((dow + 6) % 7));
}

export function askBudget(activity: ActivityRow[], profile: Profile | null, evalDate: string): AskBudget {
  const start = weekStart(evalDate);
  const week = activity.filter((a) => a.date >= start && a.date <= evalDate);
  const asks = week.filter(isAsk).length;
  const gives = week.filter((a) => !isAsk(a) && a.kind !== "note_logged").length;
  const asksPerWeek = profile?.asks_per_week ?? DEFAULT_PROFILE.asks_per_week;
  const givesPerAsk = profile?.gives_per_ask ?? DEFAULT_PROFILE.gives_per_ask;
  const earned = givesPerAsk ? Math.floor(gives / givesPerAsk) : asksPerWeek;
  const open = Math.max(0, Math.min(asksPerWeek, earned) - asks);
  const givesToUnlock = open > 0 || asks >= asksPerWeek ? 0 : givesPerAsk * (asks + 1) - gives;
  return { asksPerWeek, givesPerAsk, gives, asks, open, givesToUnlock };
}

export async function loadAskBudget(ctx: Ctx, evalDate: string, profile: Profile | null): Promise<AskBudget> {
  const activity = must<ActivityRow[]>(
    await ctx.db
      .from("activity")
      .select("date, kind, detail")
      .eq("owner_id", ctx.ownerId)
      .gte("date", weekStart(evalDate))
      .lte("date", evalDate),
  );
  return askBudget(activity, profile, evalDate);
}

export function moveFor(
  c: Pick<Contact, "relationship_strength">,
  input: { introTo: string | null; need: string | null; ask: { score: number; title: string } | null },
  budget: AskBudget,
): Move {
  // An intro you can make always comes first: give before you ask.
  if (input.introTo) return { kind: "give", why: `Intro to ${input.introTo}` };
  const askable = input.ask != null && input.ask.score >= ASK_MIN_SCORE && c.relationship_strength >= ASK_MIN_STRENGTH;
  if (askable && budget.open > 0) return { kind: "ask", why: input.ask!.title };
  if (askable && budget.asksPerWeek > 0) {
    return {
      kind: "give",
      why:
        budget.asks >= budget.asksPerWeek
          ? "Worth an ask, but this week's asks are used"
          : `Worth an ask: unlocks after ${budget.givesToUnlock} more ${budget.givesToUnlock === 1 ? "give" : "gives"}`,
    };
  }
  if (input.need) return { kind: "give", why: `Help with ${lower(input.need)}` };
  return { kind: "give", why: "Check in, no agenda" };
}

const byPriority = (a: SignalRow, b: SignalRow) =>
  Number(b.time_sensitive) - Number(a.time_sensitive) || b.interactions.date.localeCompare(a.interactions.date);

/** Next move for every contact, for pages that don't build Today (Contacts, the contact page, chat). */
export async function buildMoves(
  ctx: Ctx,
  evalDate: string,
  pre: { briefing?: Briefing; semantic?: Map<string, ProfileFit> } = {},
): Promise<{ moves: Map<string, Move>; budget: AskBudget }> {
  const { db, ownerId } = ctx;
  const [briefing, contacts, signals] = await Promise.all([
    pre.briefing ?? buildBriefing(ctx, evalDate),
    db.from("contacts").select("*").eq("owner_id", ownerId).then((r) => must<Contact[]>(r)),
    db
      .from("signals")
      .select("*, interactions(date)")
      .eq("owner_id", ownerId)
      .eq("status", "active")
      .then((r) => must<SignalRow[]>(r)),
  ]);
  const profile = briefing.profile;
  const [semantic, budget] = await Promise.all([
    pre.semantic ?? profileFit(ctx, profile),
    loadAskBudget(ctx, evalDate, profile),
  ]);

  // Best intro per recipient (highest score first).
  const introTo = new Map<string, string>();
  for (const x of [...briefing.recommendations, ...briefing.alsoConsidered].sort((a, b) => b.score.total - a.score.total)) {
    if (!introTo.has(x.recipient.id)) introTo.set(x.recipient.id, x.proposed.name);
  }
  const signalsFor = new Map<string, SignalRow[]>();
  for (const s of signals) signalsFor.set(s.contact_id, [...(signalsFor.get(s.contact_id) ?? []), s]);

  const moves = new Map<string, Move>();
  for (const c of contacts) {
    const active = activeSignals(signalsFor.get(c.id) ?? [], evalDate).sort(byPriority);
    const needs = active.filter((s) => s.type === "need");
    const offers = active.filter((s) => s.type === "offer");
    const ask = bestAsk(goalFit(c, needs, profile, semantic.get(c.id)), askPotential(c, offers, profile));
    moves.set(c.id, moveFor(c, { introTo: introTo.get(c.id) ?? null, need: needs[0]?.description ?? null, ask }, budget));
  }
  return { moves, budget };
}
