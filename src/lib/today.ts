import { buildBriefing, type Briefing, type Candidate } from "./briefing";
import { INDUSTRIES, type Goal, type Profile } from "./profile";
import { coolingScore, daysBetween, MIN_PROPOSED_STRENGTH, STALE_AFTER_DAYS } from "./scoring";
import { must, type Ctx } from "./supabase";
import type { Contact, Signal } from "./types";

// Today: the people worth talking to today, and why. An introduction you can make is one
// reason among several; the others are a cooling relationship, something timely (a deadline
// they mentioned, news about them), a fit with what you're looking for, and intros you've
// already started. Every factor is computed deterministically from stored facts, so the
// ranking is reproducible for a given date and every reason points at its evidence.

export type FactorKey = "give" | "loop" | "cooling" | "timing" | "fit" | "relationship";

export const FACTOR_LABELS: Record<FactorKey, string> = {
  give: "Intro you can make",
  loop: "Intro in progress",
  cooling: "Time to reconnect",
  timing: "Something timely",
  fit: "Fits your goal",
  relationship: "Relationship strength",
};

/** Factor weights per onboarding goal. Each row sums to 1. */
const WEIGHTS: Record<Goal, Record<FactorKey, number>> = {
  give: { give: 0.4, loop: 0.15, cooling: 0.15, timing: 0.15, fit: 0.05, relationship: 0.1 },
  clients: { give: 0.2, loop: 0.1, cooling: 0.15, timing: 0.2, fit: 0.3, relationship: 0.05 },
  referrals: { give: 0.25, loop: 0.1, cooling: 0.2, timing: 0.1, fit: 0.1, relationship: 0.25 },
  winback: { give: 0.15, loop: 0.1, cooling: 0.4, timing: 0.15, fit: 0.1, relationship: 0.1 },
  partners: { give: 0.3, loop: 0.1, cooling: 0.15, timing: 0.15, fit: 0.25, relationship: 0.05 },
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
};

export type Today = {
  evalDate: string;
  people: TodayPerson[];
  /** People with a reason who didn't make today's cut. */
  more: TodayPerson[];
  briefing: Briefing;
  profile: Profile | null;
};

type NeedRow = Signal & { interactions: { date: string } };

// What the user offers, matched loosely against a contact's stated needs.
const OFFER_PATTERNS: Record<string, RegExp> = {
  marketing: /marketing|\bcmo\b|growth|demand[- ]gen|brand|launch|seo|podcast|pr\b|content/i,
  sales: /sales|business development|pipeline|customers?|leads/i,
  finance: /\bcfo\b|accounting|bookkeep|financ|tax/i,
  legal: /legal|attorney|lawyer|contract|m&a/i,
  it: /\bit\b|cyber|security|cloud|infrastructure/i,
  software: /software|engineer|developer|automation|data|\bai\b/i,
  consulting: /strategy|consult|advis|operations/i,
  coaching: /coach|training|mentor/i,
  hr: /hiring|recruit|talent|\bhr\b|vp of engineering|head of/i,
  investing: /investor|fundrais|seed|series [a-d]|capital|funding/i,
  realestate: /real estate|office space|property/i,
  creative: /design|video|creative|website/i,
};

const ROLE_PATTERNS: Record<string, RegExp> = {
  owner: /\b(ceo|founder|co-founder|owner|president)\b/i,
  csuite: /\b(coo|cfo|cmo|cto|cio|chief)\b/i,
  vp: /\b(vp|vice president|director|partner|head)\b/i,
  manager: /\bmanager|lead\b/i,
  ic: /engineer|analyst|specialist|associate|agent|producer/i,
  investor: /investor|partner|venture|angel|\bvc\b/i,
};

const words = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);

function industryMatch(c: Contact, wanted: string[]): string | null {
  const theirs = words(`${c.industry ?? ""} ${c.company ?? ""}`);
  for (const ind of wanted) {
    if (ind === "Other" || !INDUSTRIES.includes(ind as (typeof INDUSTRIES)[number])) continue;
    if (words(ind).some((w) => theirs.some((t) => t.startsWith(w.slice(0, 5))))) return ind;
  }
  return null;
}

const first = (name: string) => name.split(" ")[0];
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function assess(
  c: Contact,
  evalDate: string,
  introsFor: Map<string, Candidate[]>,
  needsFor: Map<string, NeedRow[]>,
  profile: Profile | null,
): TodayPerson | null {
  if (c.relationship_strength < MIN_PROPOSED_STRENGTH) return null;
  if (c.outreach_snoozed_until && c.outreach_snoozed_until > evalDate) return null;
  const rest = profile?.rest_days ?? DEFAULT_REST_DAYS;
  if (c.last_outreach_at && daysBetween(c.last_outreach_at, evalDate) < rest) return null;

  const daysSinceSpoke = c.last_interaction_date ? daysBetween(c.last_interaction_date, evalDate) : null;
  const weights = WEIGHTS[profile?.goal ?? "give"];
  const factors: Record<FactorKey, number> = { give: 0, loop: 0, cooling: 0, timing: 0, fit: 0, relationship: 0 };
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
  const needs = (needsFor.get(c.id) ?? []).filter(
    (n) => (!n.relevant_until || n.relevant_until >= evalDate) && daysBetween(n.interactions.date, evalDate) <= STALE_AFTER_DAYS,
  );
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
  if (profile) {
    const offerHit = needs.find((n) => profile.offers.some((o) => OFFER_PATTERNS[o]?.test(n.description)));
    const ind = industryMatch(c, profile.industries);
    const role = profile.roles.find((r) => ROLE_PATTERNS[r]?.test(c.title ?? ""));
    if (offerHit && profile.goal !== "give") {
      factors.fit = 1;
      reasons.push({
        kind: "fit",
        title: `Needs ${offerHit.description.charAt(0).toLowerCase()}${offerHit.description.slice(1)}: your area`,
        detail: "Lead with help, not a pitch.",
        source: { label: `${first(c.name)}, ${offerHit.interactions.date}: “${offerHit.supporting_text}”` },
      });
    } else if (ind || role) {
      factors.fit = ind && role ? 0.8 : 0.5;
      reasons.push({ kind: "fit", title: `Matches your ideal client`, detail: [ind, c.title].filter(Boolean).join(" · ") });
    }
  }

  factors.relationship = c.relationship_strength / 5;
  if (profile?.goal === "referrals" && c.relationship_strength >= 4) {
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
    reasons: reasons
      .map((r) => ({ ...r, points: contribution(r.kind) }))
      .sort((a, b) => b.points - a.points),
  };
}

export async function buildToday(ctx: Ctx, evalDate: string): Promise<Today> {
  const [briefing, contacts, needs] = await Promise.all([
    buildBriefing(ctx, evalDate),
    ctx.db.from("contacts").select("*").eq("owner_id", ctx.ownerId).then((r) => must<Contact[]>(r)),
    ctx.db
      .from("signals")
      .select("*, interactions(date)")
      .eq("owner_id", ctx.ownerId)
      .eq("type", "need")
      .eq("status", "active")
      .then((r) => must<NeedRow[]>(r)),
  ]);
  const profile = briefing.profile;

  // Eligible intros per recipient, best first (briefing order is already by score).
  const introsFor = new Map<string, Candidate[]>();
  for (const c of [...briefing.recommendations, ...briefing.alsoConsidered].sort((a, b) => b.score.total - a.score.total)) {
    introsFor.set(c.recipient.id, [...(introsFor.get(c.recipient.id) ?? []), c]);
  }
  const needsFor = new Map<string, NeedRow[]>();
  for (const n of needs) needsFor.set(n.contact_id, [...(needsFor.get(n.contact_id) ?? []), n]);

  const ranked = contacts
    .map((c) => assess(c, evalDate, introsFor, needsFor, profile))
    .filter((p): p is TodayPerson => p !== null)
    .sort((a, b) => b.score - a.score || a.contact.id.localeCompare(b.contact.id));

  const perDay = profile?.per_day ?? DEFAULT_PER_DAY;
  return { evalDate, people: ranked.slice(0, perDay), more: ranked.slice(perDay), briefing, profile };
}
