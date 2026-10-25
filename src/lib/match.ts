import { z } from "zod";
import { MATCH_MODEL, structuredCall } from "./claude";
import { getProfile, profilePrompt } from "./profile";
import { must, type Ctx } from "./supabase";
import { enrichmentLine } from "./enrich";
import type { Contact, Signal } from "./types";
import { candidatesFor, RETRIEVAL_THRESHOLD, syncContactDocuments } from "./vectors";

// Stages B + C (PRD §8): candidate generation and match validation.
// Claude sees the directory and proposes candidates for a batch of needs; code then validates ids
// and stores the assessments. Above RETRIEVAL_THRESHOLD contacts the directory is narrowed per batch
// by keyword + semantic retrieval (vectors.ts).
// Final priority scores are computed deterministically in scoring.ts.

export const MatchSchema = z.object({
  need_ref: z.string().describe("The N# reference of the need"),
  proposed_ref: z.string().describe("The P# reference of the person the user would introduce"),
  offer_ref: z.string().nullable().describe("The O# reference of the matching recorded offer, or null if the match is based only on their profile"),
  give_value: z.number().int().describe("0-5 rubric score"),
  match_basis: z.enum(["stated_offer", "profile_inference"]),
  match_confidence: z.number().describe("0-1: how trustworthy and specific the evidence is"),
  timeliness: z.number().int().describe("0-5: is there a current reason (deadline, active process, recent mention)?"),
  value_proposition: z.string().describe("Max 15 words: what the recipient gets from this introduction"),
  why_proposed: z.string().describe("Max 20 words: why this person, grounded in their recorded offer or profile"),
  why_now: z.string().nullable().describe("Max 12 words, or null if there is no current trigger"),
  appropriate: z.boolean().describe("false if the intro would violate a stated preference, confidentiality, or be otherwise inappropriate"),
  concerns: z.string().nullable().describe("Max 15 words: a preference, sensitivity, or risk the user must respect; null if none"),
  missing_evidence: z.string().nullable().describe("Max 15 words: the most important unknown; null if none beyond consent"),
});

const MatchResultSchema = z.object({ matches: z.array(MatchSchema) });

const SYSTEM = `You help the user find introductions that give genuine value to people in their network. An introduction is directional: the RECIPIENT has a need; the PROPOSED contact can address it.

Give Value rubric (0-5):
0 no identifiable value; 1 generic possible benefit; 2 some relevance but speculative; 3 concrete alignment with an expressed need; 4 strong match to a current need; 5 highly specific, actionable, potentially high-impact.

Rules:
- Ground every claim in the recorded needs, offers, and profiles. Never invent facts about people.
- A stated offer is stronger evidence than a job title. If you rely on a title/profile only, use match_basis=profile_inference and lower match_confidence.
- Check both people's introduction preferences and any sensitivities. A good match that violates a stated preference or confidentiality is appropriate=false, or appropriate=true with the concern spelled out if a permission-first approach makes it safe (e.g. asking the person privately first).
- Respect stated investment criteria (stage, sector, traction). Mismatches lower give_value.
- Needs marked INFERRED are assumptions; reflect that in match_confidence.
- For each need, return up to 3 candidates, best first. Include a notable rejected candidate (low give_value or appropriate=false) only if it is an obvious-looking match that should NOT be made. Return nothing for a need with no plausible match.
- Never propose the recipient themselves.
- "public web" lines are unverified context from web search. They can support why_now or a profile_inference, but never count as a stated need or stated offer.
- The user's goal and ideal clients (below) are context for tie-breaking only. Never raise give_value because a match serves the user's own business; value to the recipient is what counts.
- Write tersely: the user reads each recommendation in under 30 seconds. Respect the word limits.
- The N#/O#/P# references are internal. Never mention them in any text field; refer to people by name.`;

export function contactLine(ref: string, c: Contact) {
  const pref = c.introduction_preferences ? ` | intro preferences: ${c.introduction_preferences}` : "";
  return `${ref}: ${c.name}, ${c.title ?? "?"} at ${c.company ?? "?"} (${c.industry ?? "?"}), relationship strength ${c.relationship_strength}/5${pref}`;
}

export function signalLine(ref: string, s: Signal) {
  const flags = [s.is_inferred ? "INFERRED" : "stated", `confidence ${s.confidence}`, s.time_sensitive ? "time-sensitive" : null]
    .filter(Boolean)
    .join(", ");
  return `${ref} [${s.category}] ${s.description} (${flags}) - evidence: "${s.supporting_text}"`;
}

/** Matching instructions plus who the user is (offer, goal, ideal clients). Shared by every matching path. */
export async function matchSystem(ctx: Ctx): Promise<string> {
  return `${SYSTEM}\n\nAbout the user: ${profilePrompt(await getProfile(ctx))}`;
}

export async function findIntroductions(ctx: Ctx): Promise<{ needs: number; matches: number }> {
  const { db: supabase, ownerId } = ctx;
  const contacts = must<Contact[]>(
    await supabase.from("contacts").select("*").eq("owner_id", ownerId).order("created_at").order("id"),
  );
  const signals = must<(Signal & { interactions: { date: string; context: { uncertainties?: string[] } | null } })[]>(
    await supabase.from("signals").select("*, interactions(date, context)").eq("owner_id", ownerId).eq("status", "active").order("created_at"),
  );

  const system = await matchSystem(ctx);
  const needs = signals.filter((s) => s.type === "need");
  const offers = signals.filter((s) => s.type === "offer");
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  // Short refs keep prompts compact and avoid asking the model to copy UUIDs.
  const contactRef = new Map(contacts.map((c, i) => [`P${i + 1}`, c]));
  const refByContact = new Map([...contactRef].map(([ref, c]) => [c.id, ref]));

  const needRef = new Map(needs.map((s, i) => [`N${i + 1}`, s]));
  const offerRef = new Map(offers.map((s, i) => [`O${i + 1}`, s]));
  const offerRefBySignal = new Map([...offerRef].map(([ref, s]) => [s.id, ref]));

  // Directory: every contact with their recorded offers and sensitivities.
  const entryById = new Map(
    [...contactRef].map(([ref, c]) => {
      const theirOffers = offers.filter((o) => o.contact_id === c.id);
      const sensitivities = signals
        .filter((s) => s.contact_id === c.id)
        .flatMap((s) => s.interactions?.context?.uncertainties ?? []);
      const lines = [contactLine(ref, c)];
      for (const o of theirOffers) lines.push(`  offer ${signalLine(offerRefBySignal.get(o.id)!, o)}`);
      for (const u of new Set(sensitivities)) lines.push(`  note: ${u}`);
      const web = enrichmentLine(c.enrichment);
      if (web) lines.push(`  ${web}`);
      return [c.id, lines.join("\n")];
    }),
  );
  const directoryOf = (ids?: Set<string>) =>
    contacts
      .filter((c) => !ids || ids.has(c.id))
      .map((c) => entryById.get(c.id)!)
      .join("\n");

  const entries = [...needRef];
  const batches: (typeof entries)[] = [];
  for (let i = 0; i < entries.length; i += 6) batches.push(entries.slice(i, i + 6));

  // Large networks: each batch sees only its recipients plus the best candidates per need
  // (vectors.ts), not the whole directory. Refs stay global, so validation below is unchanged.
  // Documents are synced on every run so profile fit stays current; matching works without them.
  const synced = await syncContactDocuments(ctx).then(
    () => true,
    (e) => (console.error("Contact document sync failed:", e), false),
  );
  const shortlists =
    synced && contacts.length > RETRIEVAL_THRESHOLD
      ? await Promise.all(
          batches.map(async (batch) => {
            const lists = await candidatesFor(
              ctx,
              batch.map(([, s]) => ({ text: `${s.category}: ${s.description}. ${s.supporting_text}`, exclude: [s.contact_id] })),
            );
            return new Set([...lists.flat(), ...batch.map(([, s]) => s.contact_id)]);
          }),
        ).catch((e) => (console.error("Retrieval failed; using the full directory:", e), null))
      : null;

  const results = await Promise.all(
    batches.map((batch, b) =>
      structuredCall({
        system,
        user: `<network>
${directoryOf(shortlists?.[b])}
</network>

Find introductions for these needs:
${batch
  .map(([ref, s]) => {
    const c = contactById.get(s.contact_id)!;
    return `RECIPIENT ${refByContact.get(c.id)} (${c.name}), noted ${s.interactions.date}: ${signalLine(ref, s)}`;
  })
  .join("\n")}`,
        schema: MatchResultSchema,
        model: MATCH_MODEL,
        effort: "high",
      }),
    ),
  );

  const rows = results
    .flatMap((r) => r.matches)
    .flatMap((m) => {
      const need = needRef.get(m.need_ref);
      const proposed = contactRef.get(m.proposed_ref);
      if (!need || !proposed || proposed.id === need.contact_id) return [];
      const offer = m.offer_ref ? offerRef.get(m.offer_ref) : undefined;
      return [
        {
          owner_id: ownerId,
          recipient_contact_id: need.contact_id,
          proposed_contact_id: proposed.id,
          matched_need_id: need.id,
          matched_offer_id: offer && offer.contact_id === proposed.id ? offer.id : null,
          value_proposition: m.value_proposition,
          why_proposed: m.why_proposed,
          why_now: m.why_now,
          give_value: Math.max(0, Math.min(5, Math.round(m.give_value))),
          timeliness: Math.max(0, Math.min(5, Math.round(m.timeliness))),
          match_confidence: Math.max(0, Math.min(1, m.match_confidence)),
          match_basis: offer ? m.match_basis : "profile_inference",
          appropriate: m.appropriate,
          concerns: m.concerns,
          missing_evidence: m.missing_evidence,
          updated_at: new Date().toISOString(),
        },
      ];
    });

  // One row per (need, proposed contact); keep the strongest assessment.
  const unique = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = `${r.matched_need_id}:${r.proposed_contact_id}`;
    if ((unique.get(key)?.give_value ?? -1) < r.give_value) unique.set(key, r);
  }

  // Re-assess existing pairs in place; status/consent/draft are preserved.
  if (unique.size) {
    must(
      await supabase
        .from("opportunities")
        .upsert([...unique.values()], { onConflict: "matched_need_id,proposed_contact_id" }),
    );
  }
  return { needs: needs.length, matches: unique.size };
}
