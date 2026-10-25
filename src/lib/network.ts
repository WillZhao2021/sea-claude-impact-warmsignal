import { z } from "zod";
import { MATCH_MODEL, structuredStream } from "./claude";
import { enrichmentLine } from "./enrich";
import { contactLine, MatchSchema, matchSystem, signalLine } from "./match";
import { must, type Ctx } from "./supabase";
import type { Contact, Enrichment, NetworkMap, Signal } from "./types";

// Network mapping for one contact, run right after they are enriched: how do they fit
// everyone else? Introductions that rest on a recorded need are assessed with the same rubric
// as the briefing (match.ts) and saved as opportunities, so they flow into the briefing and its
// deterministic scoring. Ideas that rest only on public-web info are shown, never saved.

const NetworkSchema = z.object({
  goal_fit: z
    .object({
      level: z.enum(["strong", "some", "none"]),
      why: z.string().describe("Max 20 words, naming the concrete link to the user's goal (or why there is none)"),
    })
    .describe("How directly the FOCUS person relates to the user's goal (see About the user)"),
  gives: z
    .array(MatchSchema)
    .describe("Other people's recorded needs that the FOCUS person could address. proposed_ref is always the FOCUS ref."),
  receives: z
    .array(MatchSchema)
    .describe("The FOCUS person's own recorded needs, with up to 3 candidates each from the network"),
  ideas: z
    .array(
      z.object({
        text: z.string().describe("Max 20 words. A connection worth asking about, suggested only by public-web info"),
        other_ref: z.string().nullable().describe("P# of the other person involved, if any"),
      }),
    )
    .describe("Up to 4 unverified ideas that no recorded need supports yet"),
});

const FOCUS_RULES = `
You are now mapping ONE person, the FOCUS, against the whole network.
- gives: needs recorded by OTHER people that the FOCUS could address. Only include give_value >= 2.
- receives: the FOCUS's own recorded needs (listed under FOCUS NEEDS), with the best candidates from the network.
- ideas: connections suggested only by public-web info (for example, a funding round that makes a hiring intro timely). These are unverified: phrase each as something to ask about. Never repeat a gives/receives match here.
- goal_fit: how directly the FOCUS relates to the user's goal (About the user). strong = directly advances it (for example an ideal client, a likely buyer of what the user offers, a referral source or partner for it); some = an indirect or plausible link; none = unrelated. Ground it in the profile, notes and public web; never guess.
- Goal fit is reported on its own. It never changes give_value, which is about value to the recipient.
- When choosing ideas, prefer ones that also move the user's goal forward, as long as they genuinely help the people involved.
- Return empty arrays when nothing qualifies. Never pad.`;

export type NetworkEvent =
  | { type: "mapping"; contacts: number; needs: number }
  | { type: "overlaps"; overlaps: NetworkMap["overlaps"] }
  | { type: "network_partial"; data: Pick<NetworkMap, "intros" | "ideas" | "goal_fit"> }
  | { type: "network"; network: NetworkMap; saved: number; added: number };

type SignalRow = Signal & { interactions: { date: string; context: { uncertainties?: string[] } | null } };

export async function mapNetworkAndSave(
  ctx: Ctx,
  contactId: string,
  enrichment: Enrichment,
  opts: { onEvent?: (e: NetworkEvent) => void; signal?: AbortSignal } = {},
): Promise<{ network: NetworkMap; saved: number; added: number }> {
  const emit = opts.onEvent ?? (() => {});
  const { db, ownerId } = ctx;
  const [contacts, signals] = await Promise.all([
    db.from("contacts").select("*").eq("owner_id", ownerId).order("created_at").order("id").then((r) => must<Contact[]>(r)),
    db
      .from("signals")
      .select("*, interactions(date, context)")
      .eq("owner_id", ownerId)
      .eq("status", "active")
      .order("created_at")
      .then((r) => must<SignalRow[]>(r)),
  ]);
  // Use the enrichment we just produced, not whatever was stored before.
  const focus = { ...contacts.find((c) => c.id === contactId)!, enrichment };
  const others = contacts.filter((c) => c.id !== contactId);
  const needs = signals.filter((s) => s.type === "need");
  emit({ type: "mapping", contacts: others.length, needs: needs.length });

  const overlaps = findOverlaps(focus, others);
  emit({ type: "overlaps", overlaps });

  const network: NetworkMap = { mapped_at: new Date().toISOString(), intros: [], ideas: [], overlaps };
  if (others.length === 0) return save(ctx, contactId, enrichment, network, 0, 0);

  // Short refs, as in findIntroductions.
  const all = [focus, ...others];
  const contactRef = new Map(all.map((c, i) => [`P${i + 1}`, c]));
  const refByContact = new Map([...contactRef].map(([ref, c]) => [c.id, ref]));
  const focusRef = refByContact.get(contactId)!;
  const offers = signals.filter((s) => s.type === "offer");
  const needRef = new Map(needs.map((s, i) => [`N${i + 1}`, s]));
  const offerRef = new Map(offers.map((s, i) => [`O${i + 1}`, s]));
  const refByNeed = new Map([...needRef].map(([ref, s]) => [s.id, ref]));
  const refByOffer = new Map([...offerRef].map(([ref, s]) => [s.id, ref]));

  const directory = [...contactRef]
    .map(([ref, c]) => {
      const lines = [contactLine(ref, c) + (c.id === contactId ? "  <-- FOCUS" : "")];
      for (const o of offers.filter((o) => o.contact_id === c.id)) lines.push(`  offer ${signalLine(refByOffer.get(o.id)!, o)}`);
      const notes = signals.filter((s) => s.contact_id === c.id).flatMap((s) => s.interactions?.context?.uncertainties ?? []);
      for (const u of new Set(notes)) lines.push(`  note: ${u}`);
      const web = enrichmentLine(c.enrichment);
      if (web) lines.push(`  ${web}`);
      return lines.join("\n");
    })
    .join("\n");
  const needList = (list: SignalRow[]) =>
    list
      .map((s) => {
        const owner = all.find((c) => c.id === s.contact_id);
        return owner ? `${refByContact.get(owner.id)} (${owner.name}), noted ${s.interactions.date}: ${signalLine(refByNeed.get(s.id)!, s)}` : null;
      })
      .filter(Boolean)
      .join("\n") || "(none)";

  const nameOf = (ref: string | null | undefined) => (ref ? (contactRef.get(ref)?.name ?? null) : null);
  // Translate refs to names before anything reaches the browser.
  const display = (p: Partial<z.infer<typeof NetworkSchema>>): Pick<NetworkMap, "intros" | "ideas" | "goal_fit"> => ({
    goal_fit: p.goal_fit?.level && p.goal_fit.why ? { level: p.goal_fit.level, why: p.goal_fit.why } : undefined,
    intros: [
      ...(p.gives ?? []).map((m) => ({ m, direction: "gives" as const, other: needRef.get(m?.need_ref)?.contact_id })),
      ...(p.receives ?? []).map((m) => ({ m, direction: "receives" as const, other: contactRef.get(m?.proposed_ref)?.id })),
    ]
      .filter(({ m, other }) => m && other && m.why_proposed)
      .map(({ m, direction, other }) => ({
        direction,
        other_contact_id: other!,
        other_name: all.find((c) => c.id === other)?.name ?? "?",
        need: needRef.get(m.need_ref)?.description ?? "",
        why: m.why_proposed,
        give_value: m.give_value ?? 0,
        appropriate: m.appropriate ?? true,
      })),
    ideas: (p.ideas ?? [])
      .filter((i) => i?.text)
      .map((i) => ({ text: i.text, other_name: nameOf(i.other_ref), other_contact_id: contactRef.get(i.other_ref ?? "")?.id ?? null })),
  });

  const out = await structuredStream({
    // Same rubric as intro matching, so the same model.
    model: MATCH_MODEL,
    system: (await matchSystem(ctx)) + "\n" + FOCUS_RULES,
    user: `<network>
${directory}
</network>

FOCUS: ${focusRef} (${focus.name})

FOCUS NEEDS:
${needList(needs.filter((s) => s.contact_id === contactId))}

OTHER PEOPLE'S NEEDS:
${needList(needs.filter((s) => s.contact_id !== contactId))}`,
    schema: NetworkSchema,
    effort: "medium",
    signal: opts.signal,
    onPartial: (data) => emit({ type: "network_partial", data: display(data as Partial<z.infer<typeof NetworkSchema>>) }),
  });

  // Keep only matches whose refs check out and point the right way.
  const gives = out.gives.filter((m) => {
    const need = needRef.get(m.need_ref);
    return need && need.contact_id !== contactId && m.proposed_ref === focusRef;
  });
  const receives = out.receives.filter((m) => {
    const need = needRef.get(m.need_ref);
    const proposed = contactRef.get(m.proposed_ref);
    return need && need.contact_id === contactId && proposed && proposed.id !== contactId;
  });

  const rows = [...gives, ...receives].map((m) => {
    const need = needRef.get(m.need_ref)!;
    const proposed = contactRef.get(m.proposed_ref)!;
    const offer = m.offer_ref ? offerRef.get(m.offer_ref) : undefined;
    const validOffer = offer && offer.contact_id === proposed.id ? offer : undefined;
    return {
      owner_id: ownerId,
      recipient_contact_id: need.contact_id,
      proposed_contact_id: proposed.id,
      matched_need_id: need.id,
      matched_offer_id: validOffer?.id ?? null,
      value_proposition: m.value_proposition,
      why_proposed: m.why_proposed,
      why_now: m.why_now,
      give_value: Math.max(0, Math.min(5, Math.round(m.give_value))),
      timeliness: Math.max(0, Math.min(5, Math.round(m.timeliness))),
      match_confidence: Math.max(0, Math.min(1, m.match_confidence)),
      match_basis: validOffer ? m.match_basis : ("profile_inference" as const),
      appropriate: m.appropriate,
      concerns: m.concerns,
      missing_evidence: m.missing_evidence,
      updated_at: new Date().toISOString(),
    };
  });
  const unique = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = `${r.matched_need_id}:${r.proposed_contact_id}`;
    if ((unique.get(key)?.give_value ?? -1) < r.give_value) unique.set(key, r);
  }
  // Count pairs the briefing didn't have yet; the rest are re-assessments of existing ones.
  let added = 0;
  if (unique.size) {
    const existing = must<{ matched_need_id: string; proposed_contact_id: string }[]>(
      await db
        .from("opportunities")
        .select("matched_need_id, proposed_contact_id")
        .eq("owner_id", ownerId)
        .in("matched_need_id", [...new Set([...unique.values()].map((r) => r.matched_need_id))]),
    );
    const known = new Set(existing.map((o) => `${o.matched_need_id}:${o.proposed_contact_id}`));
    added = [...unique.keys()].filter((k) => !known.has(k)).length;
  }
  // Same conflict target as findIntroductions: re-assesses existing pairs, keeps status/consent/drafts.
  if (unique.size) {
    must(await db.from("opportunities").upsert([...unique.values()], { onConflict: "matched_need_id,proposed_contact_id" }));
  }

  const shown = display({ gives, receives, ideas: out.ideas, goal_fit: out.goal_fit });
  network.goal_fit = shown.goal_fit;
  network.intros = shown.intros.sort((a, b) => b.give_value - a.give_value);
  network.ideas = shown.ideas.slice(0, 4);
  emit({ type: "network", network, saved: unique.size, added });
  return save(ctx, contactId, enrichment, network, unique.size, added);
}

async function save(ctx: Ctx, contactId: string, enrichment: Enrichment, network: NetworkMap, saved: number, added: number) {
  must(
    await ctx.db
      .from("contacts")
      .update({ enrichment: { ...enrichment, network } })
      .eq("owner_id", ctx.ownerId)
      .eq("id", contactId),
  );
  return { network, saved, added };
}

/** Deterministic common ground with the rest of the network: same company, industry, or tags. */
function findOverlaps(focus: Contact, others: Contact[]): NetworkMap["overlaps"] {
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  const tags = (c: Contact) =>
    c.enrichment?.status === "matched" ? (c.enrichment.attributes ?? []).map((a) => a.label) : [];
  const groups: { label: string; members: Contact[] }[] = [];
  if (focus.company) {
    groups.push({ label: `Also at ${focus.company}`, members: others.filter((c) => norm(c.company) === norm(focus.company)) });
  }
  if (focus.industry) {
    groups.push({ label: focus.industry, members: others.filter((c) => norm(c.industry) === norm(focus.industry)) });
  }
  for (const tag of tags(focus)) {
    groups.push({ label: tag, members: others.filter((c) => tags(c).some((t) => norm(t) === norm(tag))) });
  }
  const seen = new Set<string>();
  return groups
    .filter((g) => g.members.length > 0 && !seen.has(norm(g.label)) && seen.add(norm(g.label)))
    .sort((a, b) => b.members.length - a.members.length)
    .slice(0, 6)
    .map((g) => ({ label: g.label, contact_ids: g.members.map((c) => c.id), names: g.members.map((c) => c.name) }));
}
