import { INDUSTRIES, type Profile } from "./profile";
import { daysBetween, STALE_AFTER_DAYS } from "./scoring";
import type { Contact, Signal } from "./types";
import type { ProfileFit } from "./vectors";

// What we know about a contact, read two ways: how well they fit what the user is looking for
// (goalFit: an ideal client, someone who needs what they offer) and what they could give the user
// (askPotential). Used by Today's ranking and by the Give / Ask tag (moves.ts).

/** Only ask people the user knows reasonably well. */
export const ASK_MIN_STRENGTH = 3;

const first = (name: string) => name.split(" ")[0];
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Semantic industry fit below this isn't shown or counted (profileFit is calibrated per industry). */
const MIN_SEMANTIC_FIT = 0.6;

/** A need or offer with the date of the note it came from. */
export type SignalRow = Signal & { interactions: { date: string } };

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

/** Needs or offers still worth acting on: not expired and not stale. */
export function activeSignals(signals: SignalRow[], evalDate: string): SignalRow[] {
  return signals.filter(
    (n) => (!n.relevant_until || n.relevant_until >= evalDate) && daysBetween(n.interactions.date, evalDate) <= STALE_AFTER_DAYS,
  );
}

export type GoalFitResult = { score: number; title: string; detail?: string; source?: { label: string } };

/** How well a contact fits what the user is looking for (onboarding answers). Shared with Give/Ask moves. */
export function goalFit(c: Contact, needs: SignalRow[], profile: Profile | null, semantic: ProfileFit | undefined): GoalFitResult | null {
  if (!profile) return null;
  const offerHit = needs.find((n) => profile.offers.some((o) => OFFER_PATTERNS[o]?.test(n.description)));
  const ind = industryMatch(c, profile.industries);
  const role = profile.roles.find((r) => ROLE_PATTERNS[r]?.test(c.title ?? ""));
  if (offerHit && profile.goal !== "give") {
    return {
      score: 1,
      title: `Needs ${offerHit.description.charAt(0).toLowerCase()}${offerHit.description.slice(1)}: your area`,
      detail: "Lead with help, not a pitch.",
      source: { label: `${first(c.name)}, ${offerHit.interactions.date}: “${offerHit.supporting_text}”` },
    };
  }
  // Industry: the stronger of a keyword match (0.5) and the calibrated semantic match (up to 0.6).
  // Role: keyword match only (embeddings can't tell roles apart). Ideal client in both = 0.8+.
  const semanticFit = semantic && semantic.score >= MIN_SEMANTIC_FIT ? semantic.score : 0;
  const industry = Math.max(ind ? 0.5 : 0, 0.6 * semanticFit);
  const score = Math.min(1, industry + (role ? 0.3 : 0));
  if (score <= 0) return null;
  const industryLabel =
    0.6 * semanticFit > (ind ? 0.5 : 0)
      ? `${semanticFit >= 0.85 ? "Strong" : "Likely"} match for your target industry: ${semantic!.matched.label}`
      : ind;
  return { score, title: "Matches your ideal client", detail: [industryLabel, role ? c.title : null].filter(Boolean).join(" · ") };
}

export type AskPotential = GoalFitResult & { source?: { label: string; url?: string } };

/**
 * What the user could reasonably ask this contact for, from what we know: Claude's goal-fit read
 * from deep enrichment, an offer they've made in a conversation, being close enough to ask for
 * referrals, or something their public profile says they offer. The strongest one wins.
 */
export function askPotential(c: Contact, offers: SignalRow[], profile: Profile | null): AskPotential | null {
  if (c.relationship_strength < ASK_MIN_STRENGTH) return null;
  const options: AskPotential[] = [];
  const e = c.enrichment?.status === "matched" ? c.enrichment : null;
  const assessed = e?.network?.goal_fit;
  if (assessed && assessed.level !== "none") {
    options.push({ score: assessed.level === "strong" ? 1 : 0.5, title: "Can help with your goal", detail: assessed.why });
  }
  if (profile?.goal === "ask" && c.relationship_strength >= 4) {
    options.push({ score: 0.8, title: "Close enough to ask for an intro", detail: "Ask who else you should meet." });
  }
  const offer = offers[0];
  if (offer) {
    options.push({
      score: 0.6,
      title: `Could help you: ${lower(offer.description)}`,
      source: { label: `${first(c.name)}, ${offer.interactions.date}: “${offer.supporting_text}”` },
    });
  }
  const web = e?.possible_offers[0];
  if (web) {
    let host = web.source_url;
    try {
      host = new URL(web.source_url).hostname.replace(/^www\./, "");
    } catch {}
    options.push({
      score: 0.4,
      title: `Could help you: ${lower(web.text)}`,
      detail: "From their public profile, unverified.",
      source: { label: host, url: web.source_url },
    });
  }
  return options.sort((a, b) => b.score - a.score)[0] ?? null;
}

/** The stronger of goal fit and ask potential: the case for asking this person. */
export function bestAsk(fit: GoalFitResult | null, potential: AskPotential | null): GoalFitResult | null {
  if (!fit) return potential;
  if (!potential) return fit;
  return potential.score > fit.score ? potential : fit;
}
