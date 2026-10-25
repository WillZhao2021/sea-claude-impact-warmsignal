import { textCall } from "./claude";
import { buildBriefing, type Briefing } from "./briefing";
import { TONE } from "./draft";
import { profilePrompt, type Profile } from "./profile";
import { coolingScore, daysBetween, MIN_PROPOSED_STRENGTH, STALE_AFTER_DAYS } from "./scoring";
import { must, type Ctx } from "./supabase";
import type { Contact, Interaction, Signal } from "./types";

// Catch-up deck: people the user should meet with to keep the relationship warm, one card at a time.
// Ranked deterministically: a cooling connection matters most, a concrete reason to reach out
// (something the user can give them) next, then how close they are.

export const DECK_SIZE = 10;
export const SNOOZE_DAYS = 14;
/** Don't re-suggest someone just messaged; give them time to reply and meet. Onboarding's rest_days overrides it. */
export const RECENT_OUTREACH_DAYS = 21;
/** Below this, it's too soon since the last conversation to suggest another. */
export const MIN_DAYS_SINCE_MET = 30;

const CATCH_UP_WEIGHTS = { cooling: 0.5, reason: 0.3, relationship: 0.2 } as const;

export type ReasonKind = "give" | "need" | "news" | "last_time";
export type Reason = { kind: ReasonKind; text: string };

/** What a deck card renders. Shaped for the client, not raw rows. */
export type CatchUpCard = {
  id: string;
  name: string;
  title: string | null;
  company: string | null;
  relationshipStrength: number;
  daysSinceMet: number | null;
  reasons: Reason[];
  score: number;
};

type Needs = (Signal & { interactions: { date: string } })[];

async function loadInputs(ctx: Ctx, evalDate: string, briefing?: Briefing) {
  const { db, ownerId } = ctx;
  const [contacts, needs, interactions, b] = await Promise.all([
    db.from("contacts").select("*").eq("owner_id", ownerId).then((r) => must<Contact[]>(r)),
    db
      .from("signals")
      .select("*, interactions(date)")
      .eq("owner_id", ownerId)
      .eq("type", "need")
      .eq("status", "active")
      .then((r) => must<Needs>(r)),
    db
      .from("interactions")
      .select("contact_id, date, context")
      .eq("owner_id", ownerId)
      .order("date", { ascending: false })
      .then((r) => must<Pick<Interaction, "contact_id" | "date" | "context">[]>(r)),
    briefing ?? buildBriefing(ctx, evalDate),
  ]);
  return { contacts, needs, interactions, briefing: b };
}

function reasonsFor(
  c: Contact,
  { needs, interactions, briefing }: Omit<Awaited<ReturnType<typeof loadInputs>>, "contacts">,
  evalDate: string,
): Reason[] {
  const reasons: Reason[] = [];
  const first = (name: string) => name.split(" ")[0];

  // An introduction the user could offer them is the best reason to get in touch.
  const intro = [...briefing.recommendations, ...briefing.alsoConsidered].find((x) => x.recipient.id === c.id);
  if (intro) {
    reasons.push({ kind: "give", text: `You could introduce them to ${intro.proposed.name} (${intro.need.description})` });
  } else {
    const need = needs
      .filter(
        (s) =>
          s.contact_id === c.id &&
          (!s.relevant_until || s.relevant_until >= evalDate) &&
          daysBetween(s.interactions.date, evalDate) <= STALE_AFTER_DAYS,
      )
      .sort((a, b) => Number(b.time_sensitive) - Number(a.time_sensitive) || b.interactions.date.localeCompare(a.interactions.date))[0];
    if (need) reasons.push({ kind: "need", text: `${first(c.name)} mentioned: ${need.description}` });
  }

  if (c.enrichment?.status === "matched" && c.enrichment.recent_signals[0]) {
    reasons.push({ kind: "news", text: c.enrichment.recent_signals[0].text });
  }

  const last = interactions.find((i) => i.contact_id === c.id && i.context?.summary);
  if (last?.context?.summary) reasons.push({ kind: "last_time", text: last.context.summary });

  return reasons;
}

function toCard(c: Contact, reasons: Reason[], evalDate: string): CatchUpCard {
  const daysSinceMet = c.last_interaction_date ? daysBetween(c.last_interaction_date, evalDate) : null;
  const reason = reasons.some((r) => r.kind === "give") ? 1 : reasons.some((r) => r.kind === "need") ? 0.7 : reasons.some((r) => r.kind === "news") ? 0.4 : 0;
  const score =
    100 *
    (CATCH_UP_WEIGHTS.cooling * coolingScore(daysSinceMet) +
      CATCH_UP_WEIGHTS.reason * reason +
      CATCH_UP_WEIGHTS.relationship * (c.relationship_strength / 5));
  return {
    id: c.id,
    name: c.name,
    title: c.title,
    company: c.company,
    relationshipStrength: c.relationship_strength,
    daysSinceMet,
    reasons,
    score: Math.round(score * 10) / 10,
  };
}

function isDue(c: Contact, evalDate: string, restDays: number): boolean {
  if (c.relationship_strength < MIN_PROPOSED_STRENGTH) return false;
  if (c.outreach_snoozed_until && c.outreach_snoozed_until > evalDate) return false;
  if (c.last_outreach_at && daysBetween(c.last_outreach_at, evalDate) < restDays) return false;
  if (c.last_interaction_date && daysBetween(c.last_interaction_date, evalDate) < MIN_DAYS_SINCE_MET) return false;
  return true;
}

/** Today's catch-up deck, highest priority first. Pass the briefing if it's already built. */
export async function buildCatchUpDeck(ctx: Ctx, evalDate: string, briefing?: Briefing): Promise<CatchUpCard[]> {
  const inputs = await loadInputs(ctx, evalDate, briefing);
  const restDays = inputs.briefing.profile?.rest_days ?? RECENT_OUTREACH_DAYS;
  return inputs.contacts
    .filter((c) => isDue(c, evalDate, restDays))
    .map((c) => toCard(c, reasonsFor(c, inputs, evalDate), evalDate))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, DECK_SIZE);
}

// ---------- Drafts ----------

function system(profile: Profile | null): string {
  return `You draft short messages for the user, suggesting they and someone in their network meet up (coffee, lunch, or a call). ${profilePrompt(profile)} Write in their voice. Tone: ${TONE[profile?.tone ?? "warm"]}. Plain and specific: no sales tone, buzzwords, emojis, or subject line, and don't pitch the user's services. Use only the facts provided: never invent shared history, personality traits, or details. If the user can offer an introduction, mention it as something they'd like to talk through, without naming the other person. Never reveal private context or sensitivities. Output only the message text, with no signature line.`;
}

function prompt(card: CatchUpCard, c: Contact): string {
  const when = card.daysSinceMet == null ? "unknown" : `${card.daysSinceMet} days ago`;
  const label: Record<ReasonKind, string> = {
    give: "Something the user can offer them",
    need: "Something they mentioned needing",
    news: "Recent public news about them (unverified; mention only if natural)",
    last_time: "Notes from their last conversation",
  };
  return `Contact: ${c.name}, ${c.title ?? ""} at ${c.company ?? ""}
Relationship strength: ${c.relationship_strength}/5
Last spoke: ${when}
${card.reasons.map((r) => `${label[r.kind]}: ${r.text}`).join("\n")}
Sensitivities to respect: ${c.introduction_preferences ?? "none recorded"}

Write a 40-80 word message to ${c.name.split(" ")[0]} suggesting they catch up in person or on a call soon. Give one specific, genuine reason drawn from the facts above, and propose a concrete next step (e.g. "free for coffee in the next couple of weeks?").`;
}

/** Returns the cached catch-up draft for a contact, generating and saving it if missing. */
export async function getOrCreateCatchUpDraft(ctx: Ctx, contactId: string, evalDate: string, fresh = false): Promise<string> {
  const { db, ownerId } = ctx;
  const contact = must<Contact>(await db.from("contacts").select("*").eq("owner_id", ownerId).eq("id", contactId).single());
  if (contact.outreach_draft && !fresh) return contact.outreach_draft;

  const inputs = await loadInputs(ctx, evalDate);
  const card = toCard(contact, reasonsFor(contact, inputs, evalDate), evalDate);
  const outreach_draft = await textCall({ system: system(inputs.briefing.profile), user: prompt(card, contact) });
  must(await db.from("contacts").update({ outreach_draft }).eq("owner_id", ownerId).eq("id", contactId));
  return outreach_draft;
}

// ---------- Decisions ----------

export type CatchUpDecision = "sent" | "snooze";

export async function recordDecision(ctx: Ctx, contactId: string, decision: CatchUpDecision, evalDate: string) {
  const patch =
    decision === "sent"
      ? { last_outreach_at: evalDate, outreach_snoozed_until: null, outreach_draft: null }
      : { outreach_snoozed_until: new Date(Date.parse(evalDate) + SNOOZE_DAYS * 86_400_000).toISOString().slice(0, 10) };
  must(await ctx.db.from("contacts").update(patch).eq("owner_id", ctx.ownerId).eq("id", contactId));
}
