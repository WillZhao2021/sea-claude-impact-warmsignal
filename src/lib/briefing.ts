import { must, type Ctx } from "./supabase";
import { getProfile, type Profile } from "./profile";
import { daysBetween, ineligibleReason, scoreOpportunity, type ScoreBreakdown } from "./scoring";
import type { Contact, Opportunity, Signal } from "./types";

// Stage E/F (PRD §8): assemble the morning briefing from stored assessments.

/** Used when the user hasn't set "people per day" in onboarding. */
export const MAX_RECOMMENDATIONS = 5;

export type Candidate = {
  opp: Opportunity;
  recipient: Contact;
  proposed: Contact;
  need: Signal & { note_date: string };
  offer: (Signal & { note_date: string }) | null;
  score: ScoreBreakdown;
  excludedReason: string | null;
  /** Needs of the proposed contact that the recipient addresses (same intro, other direction). */
  reciprocal: Candidate[];
};

export type Briefing = {
  evalDate: string;
  recommendations: Candidate[];
  /** Eligible but not shown (lower-ranked or redundant with a shown recipient/need). */
  alsoConsidered: Candidate[];
  filteredOut: Candidate[];
  profile: Profile | null;
};

/** YYYY-MM-DD; DEMO_EVAL_DATE pins the date so demos and scores are reproducible. */
export function defaultEvalDate(): string {
  return process.env.DEMO_EVAL_DATE ?? new Date().toISOString().slice(0, 10);
}

type SignalWithDate = Signal & { interactions: { date: string } };

export async function buildBriefing(ctx: Ctx, evalDate: string): Promise<Briefing> {
  const { db: supabase, ownerId } = ctx;
  const [opps, contacts, signals, profile] = await Promise.all([
    supabase.from("opportunities").select("*").eq("owner_id", ownerId).then((r) => must<Opportunity[]>(r)),
    supabase.from("contacts").select("*").eq("owner_id", ownerId).then((r) => must<Contact[]>(r)),
    supabase
      .from("signals")
      .select("*, interactions(date)")
      .eq("owner_id", ownerId)
      .then((r) => must<SignalWithDate[]>(r)),
    getProfile(ctx),
  ]);

  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const signalById = new Map(signals.map((s) => [s.id, { ...s, note_date: s.interactions.date }]));

  const candidates: Candidate[] = opps.flatMap((opp) => {
    const recipient = contactById.get(opp.recipient_contact_id);
    const proposed = contactById.get(opp.proposed_contact_id);
    const need = signalById.get(opp.matched_need_id);
    if (!recipient || !proposed || !need) return [];
    const offer = opp.matched_offer_id ? (signalById.get(opp.matched_offer_id) ?? null) : null;
    return [
      {
        opp,
        recipient,
        proposed,
        need,
        offer,
        score: scoreOpportunity({ opp, recipient, proposed, need, needDate: need.note_date, evalDate }),
        excludedReason:
          ineligibleReason(opp, need, need.note_date, evalDate, proposed) ?? restingReason(recipient, evalDate, profile),
        reciprocal: [],
      },
    ];
  });

  // Highest score first; id breaks ties so ordering is reproducible.
  const byScore = (a: Candidate, b: Candidate) => b.score.total - a.score.total || a.opp.id.localeCompare(b.opp.id);
  const eligible = candidates.filter((c) => !c.excludedReason).sort(byScore);

  // Avoid redundant recommendations: at most one per recipient, and one per pair of
  // people (A<-B and B<-A are the same introduction; the reverse is shown as two-way value).
  const pairKey = (c: Candidate) => [c.recipient.id, c.proposed.id].sort().join("|");
  const recommendations: Candidate[] = [];
  const seenRecipients = new Set<string>();
  const seenPairs = new Map<string, Candidate>();
  for (const c of eligible) {
    if (recommendations.length >= (profile?.per_day ?? MAX_RECOMMENDATIONS)) break;
    if (seenRecipients.has(c.recipient.id) || seenPairs.has(pairKey(c))) continue;
    recommendations.push(c);
    seenRecipients.add(c.recipient.id);
    seenPairs.set(pairKey(c), c);
  }
  const alsoConsidered: Candidate[] = [];
  for (const c of eligible) {
    if (recommendations.includes(c)) continue;
    const shown = seenPairs.get(pairKey(c));
    if (shown && shown.recipient.id !== c.recipient.id) shown.reciprocal.push(c);
    else alsoConsidered.push(c);
  }

  return {
    evalDate,
    recommendations,
    alsoConsidered,
    filteredOut: candidates.filter((c) => c.excludedReason).sort(byScore),
    profile,
  };
}

/** Onboarding's "rest after a contact": nobody reappears until rest_days have passed since you reached out. */
function restingReason(recipient: Contact, evalDate: string, profile: Profile | null): string | null {
  if (!profile || !recipient.last_outreach_at) return null;
  const days = daysBetween(recipient.last_outreach_at, evalDate);
  if (days < 0 || days >= profile.rest_days) return null;
  return `Resting: you reached out ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`} (rest period ${profile.rest_days} days)`;
}
