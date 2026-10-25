import { FAST_MODEL, textCall } from "./claude";
import { buildBriefing, type Candidate } from "./briefing";
import { getProfile, profilePrompt, signOffInstruction, type Profile, type Tone } from "./profile";
import { must, type Ctx } from "./supabase";
import type { DraftKind } from "./types";

// FR-08: drafts the user can edit and send themselves. One per step of a double opt-in:
// 1) ask the recipient, 2) ask the proposed contact, 3) introduce them.

export function draftKindFor(c: Candidate): DraftKind {
  if (c.opp.consent_status === "approved") return "intro";
  if (c.opp.consent_status === "pending") return "ask_proposed";
  return "ask_recipient";
}

export const TONE: Record<Tone, string> = {
  warm: "warm, friendly and personal",
  professional: "polished and professional, still human",
  brief: "very brief and direct; shorten to the low end of the word range",
};

function system(profile: Profile | null): string {
  return `You draft short messages for the user, who helps people in their network by making introductions. ${profilePrompt(profile)} Write in their voice. Tone: ${TONE[profile?.tone ?? "warm"]}. Plain and specific: no sales tone, buzzwords, emojis, or subject line, and never pitch the user's own services in an intro. Use only the facts provided: never invent personality traits, achievements, or details. Never reveal private context or sensitivities the other person wouldn't want shared. Output only the message text. ${signOffInstruction(profile)}`;
}

const first = (name: string) => name.split(" ")[0];

function prompt(c: Candidate, kind: DraftKind): string {
  const facts = `Recipient (has the need): ${c.recipient.name}, ${c.recipient.title ?? ""} at ${c.recipient.company ?? ""}
Their need: ${c.need.description} (they said: "${c.need.supporting_text}" on ${c.need.note_date})
Person who can help: ${c.proposed.name}, ${c.proposed.title ?? ""} at ${c.proposed.company ?? ""}
Why them: ${c.opp.why_proposed}
${c.reciprocal.length ? `It also helps ${first(c.proposed.name)}: ${c.reciprocal.map((r) => r.need.description).join("; ")}` : ""}
Sensitivities to respect: ${c.opp.concerns ?? "none recorded"}`;

  switch (kind) {
    case "ask_recipient":
      return `${facts}

Write a 50-90 word message to ${first(c.recipient.name)} asking whether they'd like an introduction to someone who fits their need. Describe the person enough to be compelling, but do not share their name or details unless the sensitivities allow it. Make clear the user will check with the other person first.`;
    case "ask_proposed":
      return `${facts}

${first(c.recipient.name)} has said yes. Write a 50-90 word message to ${first(c.proposed.name)} asking whether they'd be open to meeting ${first(c.recipient.name)}, explaining what's in it for ${first(c.proposed.name)}. Make it easy to say no.`;
    case "intro":
      return `${facts}

Both have agreed. Write a 70-120 word double opt-in introduction email addressed to both, saying who each is, why they should talk, and then stepping back ("I'll let you two take it from here").`;
  }
}

export async function draftOutreach(
  c: Candidate,
  kind: DraftKind = draftKindFor(c),
  profile: Profile | null = null,
): Promise<string> {
  return textCall({ system: system(profile), user: prompt(c, kind), model: FAST_MODEL });
}

/** Returns the stored draft for the card's current step, generating and saving it if missing. */
export async function getOrCreateDraft(ctx: Ctx, c: Candidate, profile?: Profile | null): Promise<string> {
  const kind = draftKindFor(c);
  if (c.opp.draft_message && c.opp.draft_kind === kind) return c.opp.draft_message;
  const draft_message = await draftOutreach(c, kind, profile === undefined ? await getProfile(ctx) : profile);
  must(
    await ctx.db
      .from("opportunities")
      .update({ draft_message, draft_kind: kind })
      .eq("owner_id", ctx.ownerId)
      .eq("id", c.opp.id),
  );
  return draft_message;
}

/** Pre-generates drafts for today's recommendations so the briefing opens instantly. */
export async function ensureDrafts(ctx: Ctx, evalDate: string): Promise<void> {
  const { recommendations, profile } = await buildBriefing(ctx, evalDate);
  await Promise.all(recommendations.map((c) => getOrCreateDraft(ctx, c, profile)));
}
