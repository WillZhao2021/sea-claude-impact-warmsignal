import { randomUUID } from "node:crypto";
import snapshot from "../../data/demo_snapshot.json";
import { must, type Ctx } from "./supabase";

// Demo network: fictional contacts + notes (already extracted, matched and drafted) and a few
// public figures (web-enriched only). Copied into the user's own account with fresh ids,
// so loading it is instant and makes no Claude/Tavily calls.

type Row = Record<string, unknown>;
const snap = snapshot as unknown as {
  contacts: (Row & { external_id: string })[];
  interactions: (Row & { key: string; contact: string })[];
  signals: (Row & { key: string; contact: string; interaction: string })[];
  opportunities: (Row & { recipient: string; proposed: string; need: string; offer: string | null })[];
};

export const DEMO_EXTERNAL_IDS = snap.contacts.map((c) => c.external_id);
/** Made-up demo people (not the public figures, whose ids start with "p"). Never web-searched on a schedule. */
export const DEMO_FICTIONAL_IDS = new Set(DEMO_EXTERNAL_IDS.filter((id) => !id.startsWith("p")));

export async function hasDemoData(ctx: Ctx): Promise<boolean> {
  const { count } = await ctx.db
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", ctx.ownerId)
    .in("external_id", DEMO_EXTERNAL_IDS);
  return (count ?? 0) > 0;
}

export async function loadDemoData(ctx: Ctx): Promise<void> {
  if (await hasDemoData(ctx)) throw new Error("Demo contacts are already loaded");
  const owner_id = ctx.ownerId;
  const ids = new Map<string, string>(); // snapshot key -> new id
  const id = (key: string) => {
    if (!ids.has(key)) ids.set(key, randomUUID());
    return ids.get(key)!;
  };

  const strip = (row: Row) =>
    Object.fromEntries(Object.entries(row).filter(([k]) => !["key", "contact", "interaction"].includes(k)));

  must(await ctx.db.from("contacts").insert(snap.contacts.map((c) => ({ ...c, id: id(c.external_id), owner_id }))));
  must(
    await ctx.db
      .from("interactions")
      .insert(snap.interactions.map((i) => ({ ...strip(i), id: id(i.key), contact_id: id(i.contact), owner_id }))),
  );
  must(
    await ctx.db.from("signals").insert(
      snap.signals.map((s) => ({
        ...strip(s),
        id: id(s.key),
        contact_id: id(s.contact),
        interaction_id: id(s.interaction),
        owner_id,
      })),
    ),
  );
  must(
    await ctx.db.from("opportunities").insert(
      snap.opportunities.map(({ recipient, proposed, need, offer, ...o }) => ({
        ...o,
        recipient_contact_id: id(recipient),
        proposed_contact_id: id(proposed),
        matched_need_id: id(need),
        matched_offer_id: offer ? id(offer) : null,
        owner_id,
      })),
    ),
  );
}

/** Deletes the demo contacts (and, by cascade, their notes, needs/offers and intros). */
export async function removeDemoData(ctx: Ctx): Promise<void> {
  must(
    await ctx.db.from("contacts").delete().eq("owner_id", ctx.ownerId).in("external_id", DEMO_EXTERNAL_IDS),
  );
}
