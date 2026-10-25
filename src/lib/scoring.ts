// Stage D (PRD §5): deterministic priority scoring.
// Priority = 100 × (0.45G + 0.20C + 0.15T + 0.10R + 0.10M), every component normalized to 0–1.
// Pure functions only: same inputs + same evaluation date => same score.

import type { Contact, Opportunity, Signal } from "./types";

export const WEIGHTS = { give: 0.45, cooling: 0.2, timeliness: 0.15, relationship: 0.1, confidence: 0.1 } as const;
export const MIN_GIVE_VALUE = 3;

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/** Linear interpolation over [days, points-out-of-20] knots. */
function interpolate(knots: [number, number][], x: number): number {
  if (x <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    const [x1, y1] = knots[i];
    const [x0, y0] = knots[i - 1];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return knots[knots.length - 1][1];
}

// PRD §5.4: sweet spot at 61–120 days, low when recent, tapering when dormant.
const COOLING_KNOTS: [number, number][] = [
  [0, 0],
  [14, 2],
  [15, 3],
  [30, 9],
  [31, 10],
  [60, 17],
  [61, 18],
  [90, 20],
  [120, 18],
  [121, 17],
  [180, 12],
  [365, 6],
  [730, 4],
];

export function coolingScore(daysSinceInteraction: number | null): number {
  if (daysSinceInteraction == null) return 0.5; // unknown: neutral
  return interpolate(COOLING_KNOTS, Math.max(0, daysSinceInteraction)) / 20;
}

/** How fresh the source conversation is: 1.0 within 2 weeks, fading to 0 at 120 days. */
export function recencyScore(daysSinceNote: number): number {
  if (daysSinceNote <= 14) return 1;
  return Math.max(0, 1 - (daysSinceNote - 14) / 106);
}

export type ScoreBreakdown = {
  give: number;
  cooling: number;
  timeliness: number;
  relationship: number;
  confidence: number;
  total: number;
  daysSinceInteraction: number | null;
  daysSinceNote: number;
};

export function scoreOpportunity(input: {
  opp: Opportunity;
  recipient: Contact;
  proposed: Contact;
  need: Signal;
  needDate: string;
  evalDate: string;
}): ScoreBreakdown {
  const { opp, recipient, proposed, need, needDate, evalDate } = input;
  const daysSinceInteraction = recipient.last_interaction_date
    ? daysBetween(recipient.last_interaction_date, evalDate)
    : null;
  const daysSinceNote = daysBetween(needDate, evalDate);

  const give = opp.give_value / 5;
  const cooling = coolingScore(daysSinceInteraction);
  // Claude's read of time-sensitivity, blended with how recently the need was expressed.
  const timeliness = 0.6 * (opp.timeliness / 5) + 0.4 * recencyScore(daysSinceNote);
  // The user needs familiarity with both sides to make the intro naturally.
  const relationship = (recipient.relationship_strength + proposed.relationship_strength) / 10;
  // Evidence strength: the weaker of the need's and the match's confidence; inferred needs are capped.
  const confidence = Math.min(
    opp.match_confidence,
    Number(need.confidence),
    need.is_inferred ? 0.5 : 1,
    need.quote_verified ? 1 : 0.7,
  );

  const total =
    100 *
    (WEIGHTS.give * give +
      WEIGHTS.cooling * cooling +
      WEIGHTS.timeliness * timeliness +
      WEIGHTS.relationship * relationship +
      WEIGHTS.confidence * confidence);

  const r = (n: number) => Math.round(n * 1000) / 1000;
  return {
    give: r(give),
    cooling: r(cooling),
    timeliness: r(timeliness),
    relationship: r(relationship),
    confidence: r(confidence),
    total: Math.round(total * 10) / 10,
    daysSinceInteraction,
    daysSinceNote,
  };
}

/** PRD §5.8 eligibility. Returns the reason a candidate is excluded, or null if eligible. */
export const STALE_AFTER_DAYS = 270;

/** Below this, the user doesn't know the person well enough to vouch for an intro to them. */
export const MIN_PROPOSED_STRENGTH = 2;

export function ineligibleReason(
  opp: Opportunity,
  need: Signal,
  needDate: string,
  evalDate: string,
  proposed: Contact,
): string | null {
  if (opp.give_value < MIN_GIVE_VALUE) return `Give Value ${opp.give_value}/5 is below the ${MIN_GIVE_VALUE}/5 minimum`;
  if (proposed.relationship_strength < MIN_PROPOSED_STRENGTH)
    return `No plausible relationship path: you don't know ${proposed.name} well enough (${proposed.relationship_strength}/5)`;
  if (!opp.appropriate) return `Flagged as inappropriate${opp.concerns ? `: ${opp.concerns}` : ""}`;
  if (need.status !== "active") return `Need is ${need.status}`;
  if (need.relevant_until && need.relevant_until < evalDate) return `Need expired on ${need.relevant_until}`;
  if (daysBetween(needDate, evalDate) > STALE_AFTER_DAYS)
    return `Need was last mentioned ${daysBetween(needDate, evalDate)} days ago and is likely stale`;
  if (need.is_inferred && opp.match_confidence < 0.5) return "Need is an inference and the match evidence is weak";
  if (opp.status === "dismissed") return "You dismissed this";
  if (opp.status === "completed") return "Already handled";
  if (opp.status === "deferred" && (!opp.deferred_until || opp.deferred_until > evalDate))
    return `Deferred${opp.deferred_until ? ` until ${opp.deferred_until}` : ""}`;
  if (opp.consent_status === "declined") return "A party declined the introduction";
  return null;
}
