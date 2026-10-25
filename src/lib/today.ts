import { buildBriefing, type Briefing, type Candidate } from "./briefing";
import { activeSignals, askPotential, bestAsk, goalFit, type SignalRow } from "./fit";
import { type Goal, type Profile } from "./profile";
import { coolingScore, daysBetween, MIN_PROPOSED_STRENGTH } from "./scoring";
import { loadAskBudget, moveFor, type AskBudget, type Move } from "./moves";
import { must, type Ctx } from "./supabase";
import type { Contact } from "./types";
import { profileFit, type ProfileFit } from "./vectors";

// Today: the people worth talking to today, and why. An introduction you can make is one
// reason among several; the others are a cooling relationship, something timely (a deadline
// they mentioned, news about them), a fit with what you're looking for, something they could
// give you (only while "Give before you ask" has an ask open), and intros you've already started. Every factor is computed deterministically from stored facts, so the
// ranking is reproducible for a given date and every reason points at its evidence.

export type FactorKey = "give" | "loop" | "cooling" | "timing" | "fit" | "ask" | "relationship";

export const FACTOR_LABELS: Record<FactorKey, string> = {
  give: "Intro you can make",
  loop: "Intro in progress",
  cooling: "Time to reconnect",
  timing: "Something timely",
  fit: "Fits your goal",
  ask: "Could help you",
  relationship: "Relationship strength",
};

/** Factor weights per onboarding goal. Each row sums to 1. */
/** The default when no goal is set: cultivate the network. Keep relationships warm and help where you can; no asks. */
const CULTIVATE: Record<FactorKey, number> = { give: 0.3, loop: 0.15, cooling: 0.25, timing: 0.15, fit: 0.05, ask: 0, relationship: 0.1 };

const WEIGHTS: Record<Goal, Record<FactorKey, number>> = {
  give: { give: 0.4, loop: 0.15, cooling: 0.15, timing: 0.1, fit: 0.05, ask: 0.05, relationship: 0.1 },
  ask: { give: 0.15, loop: 0.1, cooling: 0.15, timing: 0.1, fit: 0.2, ask: 0.25, relationship: 0.05 },
};

const DEFAULT_PER_DAY = 5;
const DEFAULT_REST_DAYS = 21;
/** Just talked: don't suggest them again unless there's an intro to follow up on. */
const JUST_SPOKE_DAYS = 7;
const NEWS_WINDOW_DAYS = 90;
const TIMELY_NEWS = new Set(["funding", "hiring", "launch", "leadership_change", "partnership"]);

export type ReasonKind = FactorKey;
export type TodayReason = {
  kind: ReasonKind;
  title: string;
  detail?: string;
  source?: { label: string; url?: string };
  /** Points this reason added to the score. */
  points: number;
};

export type TodayPerson = {
  contact: Contact;
  score: number;
  factors: Record<FactorKey, number>;
  weights: Record<FactorKey, number>;
  reasons: TodayReason[];
  /** The best intro you can make for them, if any; drives the suggested action. */
  intro: Candidate | null;
  daysSinceSpoke: number | null;
  /** Give / Ask: the next move with them. */
  move: Move;
};

export type Today = {
  evalDate: string;
  /** This week's ask budget ("Asks per week" and "Give before you ask"). */
  askBudget: AskBudget;
  people: TodayPerson[];
  /** People with a reason who didn't make today's cut. */
  more: TodayPerson[];
  briefing: Briefing;
  profile: Profile | null;
};

const first = (name: string) => name.split(" ")[0];
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function assess(
  c: Contact,
  evalDate: string,
  introsFor: Map<string, Candidate[]>,
  needsFor: Map<string, SignalRow[]>,
  offersFor: Map<string, SignalRow[]>,
  profile: Profile | null,
  semantic: ProfileFit | undefined,
  budget: AskBudget,
): TodayPerson | null {
  if (c.relationship_strength < MIN_PROPOSED_STRENGTH) return null;
  if (c.outreach_snoozed_until && c.outreach_snoozed_until > evalDate) return null;
  const rest = profile?.rest_days ?? DEFAULT_REST_DAYS;
  if (c.last_outreach_at && daysBetween(c.last_outreach_at, evalDate) < rest) return null;

  const daysSinceSpoke = c.last_interaction_date ? daysBetween(c.last_interaction_date, evalDate) : null;
  const weights = profile?.goal ? WEIGHTS[profile.goal] : CULTIVATE;
  const factors: Record<FactorKey, number> = { give: 0, loop: 0, cooling: 0, timing: 0, fit: 0, ask: 0, relationship: 0 };
  const reasons: Omit<TodayReason, "points">[] = [];

  // Intros: best eligible one where they're the person being helped.
  const intros = introsFor.get(c.id) ?? [];
  const inProgress = intros.find((x) => x.opp.consent_status === "pending" || x.opp.consent_status === "approved");
  const intro = inProgress ?? intros[0] ?? null;
  if (inProgress) {
    factors.loop = 1;
    const p = first(inProgress.proposed.name);
    reasons.push({
      kind: "loop",
      title:
        inProgress.opp.consent_status === "approved"
          ? `Both said yes: introduce them to ${inProgress.proposed.name}`
          : `${first(c.name)} said yes to meeting ${p}. Check with ${p} next`,
      detail: inProgress.need.description,
    });
  }
  if (intro) {
    factors.give = intro.score.total / 100;
    if (!inProgress) {
      reasons.push({
        kind: "give",
        title: `You can introduce them to ${intro.proposed.name}`,
        detail: intro.need.time_sensitive ? `${intro.need.description} (time-sensitive)` : intro.need.description,
        source: { label: `${first(c.name)}, ${intro.need.note_date}: “${intro.need.supporting_text}”` },
      });
    }
  }

  // Cooling: the PRD curve peaks at 61–120 days since you last spoke.
  factors.cooling = coolingScore(daysSinceSpoke);
  if (daysSinceSpoke != null && factors.cooling >= 0.5) {
    reasons.push({
      kind: "cooling",
      title: daysSinceSpoke > 180 ? `Gone quiet: ${plural(daysSinceSpoke, "day")} since you spoke` : `${plural(daysSinceSpoke, "day")} since you last spoke`,
      detail: daysSinceSpoke > 180 ? "Worth a light check-in before the relationship goes cold." : "A good moment to reconnect.",
    });
  }

  // Timing: a deadline they mentioned, or recent news about them.
  const needs = activeSignals(needsFor.get(c.id) ?? [], evalDate);
  // A need already covered by the intro above isn't counted twice.
  const urgent = needs.find(
    (n) => n.time_sensitive && n.id !== intro?.need.id && daysBetween(n.interactions.date, evalDate) <= 120,
  );
  if (urgent) {
    factors.timing = 1;
    reasons.push({
      kind: "timing",
      title: `Time-sensitive: ${urgent.description}`,
      detail: urgent.relevant_until ? `Relevant until ${urgent.relevant_until}.` : undefined,
      source: { label: `${first(c.name)}, ${urgent.interactions.date}: “${urgent.supporting_text}”` },
    });
  }
  if (c.enrichment?.status === "matched") {
    const news = c.enrichment.recent_signals.find(
      (s) => TIMELY_NEWS.has(s.kind) && s.date && daysBetween(s.date, evalDate) >= 0 && daysBetween(s.date, evalDate) <= NEWS_WINDOW_DAYS,
    );
    if (news) {
      factors.timing = Math.max(factors.timing, 0.8);
      reasons.push({
        kind: "timing",
        title: `In the news: ${news.text}`,
        detail: `${news.date}. Public web, unverified.`,
        source: { label: new URL(news.source_url).hostname.replace(/^www\./, ""), url: news.source_url },
      });
    }
  }

  // Fit with what the user is looking for (onboarding answers).
  const fit = goalFit(c, needs, profile, semantic);
  if (fit) {
    factors.fit = fit.score;
    reasons.push({ kind: "fit", title: fit.title, detail: fit.detail, source: fit.source });
  }

  // Something they could give the user. Ranked up only while an ask is open, so asks wait for gives.
  const potential = askPotential(c, activeSignals(offersFor.get(c.id) ?? [], evalDate), profile);
  if (potential && budget.open > 0) {
    factors.ask = potential.score;
    reasons.push({ kind: "ask", title: potential.title, detail: potential.detail, source: potential.source });
  }

  factors.relationship = c.relationship_strength / 5;
  if (profile?.goal === "ask" && c.relationship_strength >= 4 && !factors.ask) {
    reasons.push({ kind: "relationship", title: `Close relationship (${c.relationship_strength}/5)`, detail: "A natural person to ask who else you should meet." });
  }

  // Need at least one real reason; closeness alone isn't one.
  if (!reasons.length) return null;
  if (daysSinceSpoke != null && daysSinceSpoke < JUST_SPOKE_DAYS && !inProgress) return null;

  const contribution = (k: FactorKey) => Math.round(weights[k] * factors[k] * 1000) / 10;
  const score = Math.round(
    (Object.keys(factors) as FactorKey[]).reduce((sum, k) => sum + 100 * weights[k] * factors[k], 0) * 10,
  ) / 10;
  return {
    contact: c,
    score,
    factors,
    weights,
    intro,
    daysSinceSpoke,
    move: moveFor(
      c,
      {
        introTo: intro?.proposed.name ?? null,
        need: [...needs].sort((a, b) => Number(b.time_sensitive) - Number(a.time_sensitive))[0]?.description ?? null,
        ask: bestAsk(fit, potential),
      },
      budget,
    ),
    reasons: reasons
      .map((r) => ({ ...r, points: contribution(r.kind) }))
      .sort((a, b) => b.points - a.points),
  };
}

export async function buildToday(ctx: Ctx, evalDate: string): Promise<Today> {
  const [briefing, contacts, signals] = await Promise.all([
    buildBriefing(ctx, evalDate),
    ctx.db.from("contacts").select("*").eq("owner_id", ctx.ownerId).then((r) => must<Contact[]>(r)),
    ctx.db
      .from("signals")
      .select("*, interactions(date)")
      .eq("owner_id", ctx.ownerId)
      .eq("status", "active")
      .then((r) => must<SignalRow[]>(r)),
  ]);
  const profile = briefing.profile;
  // Empty when embeddings aren't ready or the network is too small to calibrate; rules still apply.
  const [semantic, askBudget] = await Promise.all([profileFit(ctx, profile), loadAskBudget(ctx, evalDate, profile)]);

  // Eligible intros per recipient, best first (briefing order is already by score).
  const introsFor = new Map<string, Candidate[]>();
  for (const c of [...briefing.recommendations, ...briefing.alsoConsidered].sort((a, b) => b.score.total - a.score.total)) {
    introsFor.set(c.recipient.id, [...(introsFor.get(c.recipient.id) ?? []), c]);
  }
  const needsFor = new Map<string, SignalRow[]>();
  const offersFor = new Map<string, SignalRow[]>();
  for (const s of signals) {
    const map = s.type === "need" ? needsFor : offersFor;
    map.set(s.contact_id, [...(map.get(s.contact_id) ?? []), s]);
  }

  const ranked = contacts
    .map((c) => assess(c, evalDate, introsFor, needsFor, offersFor, profile, semantic.get(c.id), askBudget))
    .filter((p): p is TodayPerson => p !== null)
    .sort((a, b) => b.score - a.score || a.contact.id.localeCompare(b.contact.id));

  const perDay = profile?.per_day ?? DEFAULT_PER_DAY;
  return { evalDate, askBudget, people: ranked.slice(0, perDay), more: ranked.slice(perDay), briefing, profile };
}
