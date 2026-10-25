import { createHash } from "node:crypto";
import { INDUSTRIES, type Profile } from "./profile";
import { must, type Ctx } from "./supabase";
import type { Contact, Signal } from "./types";

// Retrieval with pgvector + Postgres full-text search (supabase/migrations/20261025050000_contact_documents.sql).
// Each contact has one document: who they are and what they can give. Embeddings come from
// Supabase's built-in gte-small model via the `embed` Edge Function (supabase/functions/embed).
// Used for two things:
// - Matching at scale: above RETRIEVAL_THRESHOLD contacts, each need gets the top candidates
//   instead of Claude reading the whole network.
// - Profile fit: how close each contact is to the user's ideal client, for ranking.

/** Below this, Claude reads the whole network: retrieval only pays off for large networks. */
export const RETRIEVAL_THRESHOLD = 60;
export const CANDIDATES_PER_NEED = 15;

/** gte-small reads at most 512 tokens; longer text is silently cut, so trim to the useful part. */
const MAX_DOCUMENT_CHARS = 1500;
/**
 * Each embed request must fit the Edge Function's CPU budget (~2s). Measured: ~0.15s for a short
 * text, ~0.4s for a full 1500-char document. So requests are packed by size, and run a few at a time.
 */
const EMBED_BATCH_CHARS = 4000;
const EMBED_BATCH_MAX = 8; // also enforced by the function
const EMBED_CONCURRENCY = 4;

/**
 * Fit calibration. gte-small similarities cluster high for any business text (0.74–0.87 on the
 * demo network) and each term has its own baseline, so fit is the margin above the term's median
 * across the user's contacts, scaled so FIT_FULL_MARGIN scores 1. On the demo network, real
 * industry matches sit 0.05–0.07 above the median (score 0.85–1), borderline ones ~0.04 (~0.65),
 * and non-matches under 0.03 (< 0.5).
 */
export const FIT_FULL_MARGIN = 0.06;
/** A median over fewer contacts is too noisy to calibrate against. */
export const MIN_CONTACTS_FOR_FIT = 8;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function embedBatch(ctx: Ctx, input: string[]): Promise<number[][]> {
  const { data, error } = await ctx.db.functions.invoke<{ embeddings: number[][] }>("embed", { body: { input } });
  if (data?.embeddings) return data.embeddings;
  // Over the CPU budget (HTTP 546) or a transient failure: halve the batch and retry.
  if (input.length > 1) {
    const mid = Math.ceil(input.length / 2);
    return [...(await embedBatch(ctx, input.slice(0, mid))), ...(await embedBatch(ctx, input.slice(mid)))];
  }
  throw new Error(`Embedding failed: ${error?.message ?? "no data"}`);
}

/** Embeds texts with gte-small (deterministic, normalized, 384 dims). Throws if the function is unavailable. */
export async function embed(ctx: Ctx, texts: string[]): Promise<number[][]> {
  const batches: { start: number; input: string[] }[] = [];
  let chars = Infinity;
  texts.forEach((t, i) => {
    const last = batches.at(-1);
    if (!last || chars + t.length > EMBED_BATCH_CHARS || last.input.length >= EMBED_BATCH_MAX) {
      batches.push({ start: i, input: [t] });
      chars = t.length;
    } else {
      last.input.push(t);
      chars += t.length;
    }
  });
  const out: number[][] = new Array(texts.length);
  for (let i = 0; i < batches.length; i += EMBED_CONCURRENCY) {
    await Promise.all(
      batches.slice(i, i + EMBED_CONCURRENCY).map(async (b) => {
        (await embedBatch(ctx, b.input)).forEach((e, j) => (out[b.start + j] = e));
      }),
    );
  }
  return out;
}

/** pgvector's text format. */
const vec = (v: number[]) => `[${v.join(",")}]`;

// ---------- Contact documents ----------

/** What someone can give, in plain text. Needs are left out on purpose (see the migration). */
export function documentFor(c: Contact, offers: Pick<Signal, "description" | "category">[]): string {
  const lines = [`${c.name}, ${c.title ?? ""} at ${c.company ?? ""}.`, c.industry ? `Industry: ${c.industry}.` : null];
  if (offers.length) lines.push(`Can help with: ${offers.map((o) => o.description).join("; ")}.`);
  const e = c.enrichment;
  if (e?.status === "matched") {
    lines.push(e.summary);
    if (e.attributes?.length) lines.push(`Known for: ${e.attributes.map((a) => a.label).join(", ")}.`);
    if (e.possible_offers.length) lines.push(`Possibly offers: ${e.possible_offers.map((o) => o.text).join("; ")}.`);
  }
  return lines.filter(Boolean).join("\n").slice(0, MAX_DOCUMENT_CHARS);
}

/**
 * Brings every contact's document up to date, embedding only those whose content changed.
 * Cheap when nothing changed (no embedding calls). Returns how many were re-embedded.
 */
export async function syncContactDocuments(ctx: Ctx): Promise<number> {
  const { db, ownerId } = ctx;
  const [contacts, offers, existing] = await Promise.all([
    db.from("contacts").select("*").eq("owner_id", ownerId).then((r) => must<Contact[]>(r)),
    db
      .from("signals")
      .select("contact_id, description, category")
      .eq("owner_id", ownerId)
      .eq("type", "offer")
      .eq("status", "active")
      .order("created_at")
      .then((r) => must<Pick<Signal, "contact_id" | "description" | "category">[]>(r)),
    db
      .from("contact_documents")
      .select("contact_id, content_hash")
      .eq("owner_id", ownerId)
      .then((r) => must<{ contact_id: string; content_hash: string }[]>(r)),
  ]);
  const hashById = new Map(existing.map((d) => [d.contact_id, d.content_hash]));
  const changed = contacts
    .map((c) => {
      const content = documentFor(c, offers.filter((o) => o.contact_id === c.id));
      return { contact_id: c.id, content, content_hash: sha(content) };
    })
    .filter((d) => hashById.get(d.contact_id) !== d.content_hash);
  if (!changed.length) return 0;

  const embeddings = await embed(ctx, changed.map((d) => d.content));
  must(
    await db.from("contact_documents").upsert(
      changed.map((d, i) => ({
        ...d,
        owner_id: ownerId,
        embedding: vec(embeddings[i]),
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "contact_id" },
    ),
  );
  return changed.length;
}

// ---------- Retrieval ----------

const STOPWORDS = new Set(
  "the and for with from that this their they them who what when have has had are was were will would could should about into over more most some than then also just very need needs looking help want wants".split(" "),
);

/** An OR query for websearch_to_tsquery, so any shared keyword counts (stemming happens in Postgres). */
function keywordsOf(text: string): string {
  const words = [...new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]{2,}/g) ?? [])].filter((w) => !STOPWORDS.has(w));
  return words.slice(0, 16).join(" or ");
}

/**
 * For each query, the ids of the k contacts whose documents best match it, by keyword and
 * semantic rank fused together. Call syncContactDocuments first so documents are current.
 */
export async function candidatesFor(
  ctx: Ctx,
  queries: { text: string; exclude?: string[] }[],
  k = CANDIDATES_PER_NEED,
): Promise<string[][]> {
  if (!queries.length) return [];
  const embeddings = await embed(ctx, queries.map((q) => q.text));
  return Promise.all(
    queries.map(async (q, i) => {
      const rows = must<{ contact_id: string; score: number }[]>(
        await ctx.db.rpc("match_contact_documents", {
          p_owner: ctx.ownerId,
          query_embedding: vec(embeddings[i]),
          keywords: keywordsOf(q.text),
          match_count: k,
          exclude_ids: q.exclude ?? [],
        }),
      );
      return rows.map((r) => r.contact_id);
    }),
  );
}

// ---------- Profile fit ----------

export type FitTerm = { kind: "industry"; label: string };
export type ProfileFit = {
  /** Calibrated 0–1 (see FIT_FULL_MARGIN). */
  score: number;
  /** Raw cosine similarity and its margin above the term's median, for debugging and tuning. */
  similarity: number;
  margin: number;
  /** The ideal-client term this contact is closest to, for the explanation. */
  matched: FitTerm;
};

/**
 * The user's ideal-client industries from onboarding ("Other" isn't a description). Roles are left
 * out: on the demo network gte-small couldn't tell them apart (a VC partner topped "Founder / CEO"),
 * so role fit is better done by rules on job titles.
 */
export function fitTerms(profile: Profile | null): FitTerm[] {
  if (!profile) return [];
  return profile.industries
    .filter((i) => i !== "Other" && (INDUSTRIES as readonly string[]).includes(i))
    .map((label) => ({ kind: "industry" as const, label }));
}

const termText = (t: FitTerm) => `Works in ${t.label}`;
const termKey = (t: FitTerm) => `${t.kind}:${t.label}`;

/** Re-embeds the profile's terms if they changed. Call after saving a profile; profileFit also self-heals. */
export async function refreshProfileFit(ctx: Ctx, profile: Profile | null): Promise<void> {
  const { db, ownerId } = ctx;
  const terms = fitTerms(profile);
  const stored = must<FitTerm[]>(await db.from("profile_fit_terms").select("kind, label").eq("owner_id", ownerId));
  const same = stored.length === terms.length && terms.every((t) => stored.some((s) => termKey(s) === termKey(t)));
  if (same) return;

  must(await db.from("profile_fit_terms").delete().eq("owner_id", ownerId));
  if (!terms.length) return;
  const embeddings = await embed(ctx, terms.map(termText));
  must(
    await db
      .from("profile_fit_terms")
      .insert(terms.map((t, i) => ({ owner_id: ownerId, kind: t.kind, label: t.label, embedding: vec(embeddings[i]) }))),
  );
}

/**
 * How close each contact is to the user's ideal client, keyed by contact id. One database query
 * when the profile hasn't changed; never embeds contacts. Contacts without a document are absent.
 * Returns an empty map if the profile has no terms or anything fails: ranking must not break on this.
 */
export async function profileFit(ctx: Ctx, profile: Profile | null): Promise<Map<string, ProfileFit>> {
  const fits = new Map<string, ProfileFit>();
  if (!fitTerms(profile).length) return fits;
  try {
    await refreshProfileFit(ctx, profile);
    const rows = must<{ contact_id: string; kind: FitTerm["kind"]; label: string; similarity: number; margin: number }[]>(
      await ctx.db.rpc("profile_fit", { p_owner: ctx.ownerId }),
    );
    if (rows.length < MIN_CONTACTS_FOR_FIT) return fits;
    for (const r of rows) {
      const score = Math.min(1, Math.max(0, r.margin / FIT_FULL_MARGIN));
      fits.set(r.contact_id, {
        score: Math.round(score * 1000) / 1000,
        similarity: r.similarity,
        margin: r.margin,
        matched: { kind: r.kind, label: r.label },
      });
    }
  } catch (e) {
    console.error("profileFit failed:", e);
    fits.clear();
  }
  return fits;
}
