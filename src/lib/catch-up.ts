import { FAST_MODEL, textCall } from "./claude";
import { buildBriefing, type Briefing } from "./briefing";
import { TONE } from "./draft";
import { logActivity } from "./momentum";
import { profilePrompt, signOffInstruction, type Profile } from "./profile";
import { coolingScore, daysBetween, MIN_PROPOSED_STRENGTH, STALE_AFTER_DAYS } from "./scoring";
import { must, type Ctx } from "./supabase";
import { buildToday } from "./today";
import type { Contact, Interaction, Signal } from "./types";

// Catch-up notes, in two modes:
// - Keep warm (the /catch-up deck): no-agenda upkeep with the user's closer people whose
//   connection is fading. Anyone on Today's list is left out, so the deck and Today never
//   overlap: Today is for people with a reason to talk now, the deck for staying close without one.
//   Ranked only on how much the connection has cooled and how close they are.
// - Reconnect (Today's cards without an intro): a catch-up note that can mention the reason
//   (something they need, an intro the user could offer, news).

export const DECK_SIZE = 10;
export const SNOOZE_DAYS = 14;
/** Don't re-suggest someone just messaged; give them time to reply and meet. Onboarding's rest_days overrides it. */
export const RECENT_OUTREACH_DAYS = 21;
/** Below this, it's too soon since the last conversation to suggest another. */
export const MIN_DAYS_SINCE_MET = 30;
/** Keep warm is for people the user is close to ("know well" or closer); weaker ties belong on Today when there's a reason. */
export const KEEP_WARM_MIN_STRENGTH = 3;

const KEEP_WARM_WEIGHTS = { cooling: 0.6, relationship: 0.4 } as const;

export type DraftMode = "keep_warm" | "reconnect" | "ask";
export type ReasonKind = "give" | "need" | "news" | "last_time";
/** Keep-warm cards and drafts use only shared history and talking points, never asks or offers. */
const KEEP_WARM_KINDS: ReadonlySet<ReasonKind> = new Set(["last_time", "news"]);
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
  const score =
    100 * (KEEP_WARM_WEIGHTS.cooling * coolingScore(daysSinceMet) + KEEP_WARM_WEIGHTS.relationship * (c.relationship_strength / 5));
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
  if (c.relationship_strength < Math.max(MIN_PROPOSED_STRENGTH, KEEP_WARM_MIN_STRENGTH)) return false;
  if (c.outreach_snoozed_until && c.outreach_snoozed_until > evalDate) return false;
  if (c.last_outreach_at && daysBetween(c.last_outreach_at, evalDate) < restDays) return false;
  if (c.last_interaction_date && daysBetween(c.last_interaction_date, evalDate) < MIN_DAYS_SINCE_MET) return false;
  return true;
}

const keepWarmOnly = (reasons: Reason[]) => reasons.filter((r) => KEEP_WARM_KINDS.has(r.kind));

/** The keep-warm deck, highest priority first: closer people who are cooling and not on Today's list. */
export async function buildCatchUpDeck(ctx: Ctx, evalDate: string): Promise<CatchUpCard[]> {
  const today = await buildToday(ctx, evalDate);
  const onToday = new Set(today.people.map((p) => p.contact.id));
  const inputs = await loadInputs(ctx, evalDate, today.briefing);
  const restDays = inputs.briefing.profile?.rest_days ?? RECENT_OUTREACH_DAYS;
  return inputs.contacts
    .filter((c) => !onToday.has(c.id) && isDue(c, evalDate, restDays))
    .map((c) => toCard(c, keepWarmOnly(reasonsFor(c, inputs, evalDate)), evalDate))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, DECK_SIZE);
}

// ---------- Drafts ----------

const PURPOSE: Record<DraftMode, string> = {
  reconnect:
    "If the user can offer an introduction, mention it as something they'd like to talk through, without naming the other person.",
  ask: "This message makes exactly one clear, low-pressure ask that serves the user's goal (an introduction, a referral, advice, or a short call). Lead with something genuine about them, then the single ask, phrased so it's easy to say no. Never stack favors.",
  keep_warm:
    "This is a no-agenda check-in, purely to stay close: never ask for anything, offer introductions or services, or bring up their needs or business problems. If there's a recent public milestone, a brief congratulations is fine.",
};

function system(profile: Profile | null, mode: DraftMode): string {
  const task =
    mode === "ask"
      ? "You draft short messages for the user, asking someone in their network for one specific thing."
      : "You draft short messages for the user, suggesting they and someone in their network meet up (coffee, lunch, or a call).";
  return `${task} ${profilePrompt(profile)} Write in their voice. Tone: ${TONE[profile?.tone ?? "warm"]}. Plain and specific: no sales tone, buzzwords, emojis, or subject line, and don't pitch the user's services. Use only the facts provided: never invent shared history, personality traits, or details. ${PURPOSE[mode]} Never reveal private context or sensitivities. Output only the message text. ${signOffInstruction(profile)}`;
}

function prompt(card: CatchUpCard, c: Contact, mode: DraftMode, askFor?: string): string {
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

${
    mode === "ask"
      ? `Why they're worth asking: ${askFor ?? "they fit the user's goal"}

Write a 40-80 word message to ${c.name.split(" ")[0]} that makes one specific ask drawn from the line above, tied to the user's goal. Make it easy to decline, and suggest a concrete next step (e.g. "would a 15-minute call next week work?").`
      : `Write a 40-80 word message to ${c.name.split(" ")[0]} suggesting they catch up in person or on a call soon. ${
    mode === "keep_warm"
      ? "Keep it personal and light: refer to something from their last conversation if there is one, otherwise simply say it's been a while."
      : "Give one specific, genuine reason drawn from the facts above."
  } Propose a concrete next step (e.g. "free for coffee in the next couple of weeks?").`
  }`;
}

/**
 * Returns the cached catch-up draft for a contact, generating and saving it if missing or written
 * for the other mode. Drafts saved before modes existed have no mode, so they regenerate too.
 */
export async function getOrCreateCatchUpDraft(
  ctx: Ctx,
  contactId: string,
  evalDate: string,
  fresh = false,
  mode: DraftMode = "reconnect",
  /** Ask mode: why this person is worth asking (the Give / Ask reason). */
  askFor?: string,
): Promise<string> {
  const { db, ownerId } = ctx;
  const contact = must<Contact>(await db.from("contacts").select("*").eq("owner_id", ownerId).eq("id", contactId).single());
  if (contact.outreach_draft && contact.outreach_draft_mode === mode && !fresh) return contact.outreach_draft;

  const inputs = await loadInputs(ctx, evalDate);
  const reasons = reasonsFor(contact, inputs, evalDate);
  const card = toCard(contact, mode === "keep_warm" ? keepWarmOnly(reasons) : reasons, evalDate);
  const outreach_draft = await textCall({ system: system(inputs.briefing.profile, mode), user: prompt(card, contact, mode, askFor), model: FAST_MODEL });
  must(
    await db
      .from("contacts")
      .update({ outreach_draft, outreach_draft_mode: mode })
      .eq("owner_id", ownerId)
      .eq("id", contactId),
  );
  return outreach_draft;
}

// ---------- Decisions ----------

export type CatchUpDecision = "sent" | "snooze";

/** A send counts as an ask (spending the weekly ask budget) only when the draft sent was an ask-mode draft. */
export async function recordDecision(ctx: Ctx, contactId: string, decision: CatchUpDecision, evalDate: string) {
  const { outreach_draft_mode } = must<Pick<Contact, "outreach_draft_mode">>(
    await ctx.db.from("contacts").select("outreach_draft_mode").eq("owner_id", ctx.ownerId).eq("id", contactId).single(),
  );
  const patch =
    decision === "sent"
      ? { last_outreach_at: evalDate, outreach_snoozed_until: null, outreach_draft: null }
      : { outreach_snoozed_until: new Date(Date.parse(evalDate) + SNOOZE_DAYS * 86_400_000).toISOString().slice(0, 10) };
  must(await ctx.db.from("contacts").update(patch).eq("owner_id", ctx.ownerId).eq("id", contactId));
  if (decision === "sent") await logActivity(ctx, "catch_up_sent", evalDate, {
      contactId,
      detail: outreach_draft_mode === "ask" ? "ask" : undefined,
    });
}
