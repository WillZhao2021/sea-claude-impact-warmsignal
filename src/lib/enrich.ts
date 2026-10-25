import { tavily, type TavilySearchResponse } from "@tavily/core";
import { z } from "zod";
import { FAST_MODEL, structuredCall, structuredStream } from "./claude";
import { DEMO_FICTIONAL_IDS } from "./demo";
import { must, serviceDb, type Ctx } from "./supabase";
import type { Attribute, Contact, Enrichment } from "./types";

// Automatic contact enrichment: Tavily web search -> Claude identity check + summary.
// Public-web facts are stored separately from the user's notes and labeled unverified.
// Only name/company/title leave the system (never note contents).

const EnrichmentSchema = z.object({
  identity_confidence: z
    .enum(["high", "medium", "low", "none"])
    .describe("How sure you are the results are about THIS person/company, not a namesake"),
  identity_notes: z.string().describe("One short sentence explaining the identity judgment"),
  summary: z.string().describe("1-2 sentences on who they are and what their company does. Empty if not confident."),
  attributes: z
    .array(
      z.object({
        kind: z.enum(["expertise", "sector", "location", "stage", "role", "affiliation", "interest"]),
        label: z.string().describe("1-4 words, Title Case, e.g. 'B2B SaaS', 'Seed Investing', 'San Francisco'"),
        source_url: z.string(),
      }),
    )
    .describe("Up to 12 tags that index this person for matching: expertise, sectors, locations, company/investment stage, roles held, affiliations (boards, communities, alma maters), interests"),
  recent_signals: z
    .array(
      z.object({
        kind: z.enum(["funding", "hiring", "launch", "leadership_change", "partnership", "press", "other"]),
        text: z.string().describe("Max 15 words"),
        date: z.string().nullable().describe("YYYY-MM-DD if known"),
        source_url: z.string(),
      }),
    )
    .describe("Notable events from the past ~12 months that could create a reason to reach out"),
  possible_offers: z
    .array(z.object({ text: z.string().describe("Max 12 words"), date: z.string().nullable(), source_url: z.string() }))
    .describe("Expertise, access, or resources this person demonstrably has, per the sources"),
});

const SYSTEM = `You enrich a contact record for a relationship-intelligence tool using web search results. Accuracy matters more than coverage: attaching a stranger's news to a contact would embarrass the user.

- First decide whether the results are about this exact person/company. Same name alone is not enough; company and role should line up. If unsure, use "low" or "none" and leave everything else empty.
- Only state what the sources say. Every signal, offer and attribute needs a source_url copied from the results.
- Attributes are an index for matching people across a network: prefer specific, reusable labels ("Healthcare AI", "Series A", "Enterprise Sales") over vague ones ("Business", "Leadership").
- Be terse.`;

let client: ReturnType<typeof tavily> | null = null;
function search() {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("Missing TAVILY_API_KEY");
  return (client ??= tavily({ apiKey }));
}

export type SearchGroup = { id: string; label: string; query: string };
type SearchResult = TavilySearchResponse["results"][number];

/** Progress reported while enriching, for live UIs. `partial` is Claude's unfinished output: display only. */
export type EnrichEvent =
  | { type: "searching"; queries: SearchGroup[] }
  | { type: "sources"; group: string; sources: { title: string; url: string; date: string | null }[] }
  | { type: "reading"; count: number }
  | { type: "partial"; data: unknown }
  | { type: "verifying" }
  | { type: "result"; enrichment: Enrichment };

/**
 * "basic" (default): 2 searches, for bulk and background enrichment.
 * "deep": 5 searches (talks, background, funding/hiring too), for an on-demand single contact.
 */
export type EnrichDepth = "basic" | "deep";

/** Contacts are re-enriched once their last enrichment is this old (daily cron, /api/cron/enrich). */
export const REFRESH_AFTER_DAYS = 14;

// Reputable business/tech outlets and press wires. Open news search returns a lot of SEO spam,
// so these are preferred (not required: small companies rarely make major outlets).
const NEWS_DOMAINS = [
  "reuters.com",
  "bloomberg.com",
  "wsj.com",
  "ft.com",
  "cnbc.com",
  "axios.com",
  "techcrunch.com",
  "theverge.com",
  "geekwire.com",
  "venturebeat.com",
  "businessinsider.com",
  "forbes.com",
  "fiercehealthcare.com",
  "statnews.com",
  "businesswire.com",
  "prnewswire.com",
  "globenewswire.com",
];

function searchPlan(contact: Contact, depth: EnrichDepth): (SearchGroup & { options: Record<string, unknown> })[] {
  const first = contact.name.split(" ")[0];
  const co = contact.company;
  const news = {
    searchDepth: "basic",
    topic: "news",
    timeRange: "year",
    maxResults: 5,
    includeDomains: NEWS_DOMAINS,
    includeDomainsMode: "prefer",
  };
  const plan = [
    {
      id: "person",
      label: `About ${first}`,
      query: `"${contact.name}" ${contact.title ?? ""} ${co ?? ""}`.trim(),
      options: { searchDepth: "basic", maxResults: 5 },
    },
    ...(co ? [{ id: "company", label: `${co} news`, query: `"${co}" ${contact.industry ?? ""} news`, options: news }] : []),
  ];
  if (depth === "basic") return plan;
  return [
    ...plan,
    {
      id: "talks",
      label: "Talks & interviews",
      query: `"${contact.name}" interview OR podcast OR keynote OR panel`,
      options: { searchDepth: "basic", maxResults: 4 },
    },
    {
      id: "background",
      label: "Background",
      query: `"${contact.name}" ${co ?? ""} career background board advisor`.trim(),
      options: { searchDepth: "basic", maxResults: 4 },
    },
    ...(co
      ? [{ id: "growth", label: `${co} funding & hiring`, query: `"${co}" raises OR funding OR hiring OR acquires`, options: news }]
      : []),
  ];
}

export async function enrichContact(
  contact: Contact,
  opts: { onEvent?: (e: EnrichEvent) => void; signal?: AbortSignal; depth?: EnrichDepth } = {},
): Promise<Enrichment> {
  const emit = opts.onEvent ?? (() => {});
  const t = search();
  const plan = searchPlan(contact, opts.depth ?? "basic");
  emit({ type: "searching", queries: plan.map(({ id, label, query }) => ({ id, label, query })) });
  // Report each search as soon as it returns, rather than waiting for all of them.
  const batches = await Promise.all(
    plan.map((g) =>
      t
        .search(g.query, g.options)
        .then((res) => res.results)
        .catch((e): SearchResult[] => {
          // One failed search shouldn't sink the rest.
          console.error(`Search failed (${g.id}):`, e);
          return [];
        })
        .then((results) => {
          emit({
            type: "sources",
            group: g.id,
            sources: results.map((r) => ({ title: r.title, url: r.url, date: r.publishedDate || null })),
          });
          return results;
        }),
    ),
  );

  const results = batches.flat().filter((r, i, all) => all.findIndex((x) => x.url === r.url) === i);
  if (results.length === 0) {
    const none: Enrichment = { status: "no_confident_match", identity_notes: "No web results found." };
    emit({ type: "result", enrichment: none });
    return none;
  }

  emit({ type: "reading", count: results.length });
  const call = {
    system: SYSTEM,
    user: `Contact: ${contact.name}, ${contact.title ?? "?"} at ${contact.company ?? "?"} (${contact.industry ?? "?"})

<search_results>
${results
  .map((r) => `<result url="${r.url}" date="${r.publishedDate ?? ""}">\n${r.title}\n${r.content.slice(0, results.length > 12 ? 800 : 1200)}\n</result>`)
  .join("\n")}
</search_results>`,
    schema: EnrichmentSchema,
    model: FAST_MODEL,
    effort: "low" as const,
  };
  const out = opts.onEvent
    ? await structuredStream({ ...call, signal: opts.signal, onPartial: (data) => emit({ type: "partial", data }) })
    : await structuredCall(call);

  emit({ type: "verifying" });
  if (out.identity_confidence === "low" || out.identity_confidence === "none") {
    const none: Enrichment = { status: "no_confident_match", identity_notes: out.identity_notes };
    emit({ type: "result", enrichment: none });
    return none;
  }
  // Drop anything not traceable to a returned source.
  const urls = new Set(results.map((r) => r.url));
  const cited = <T extends { source_url: string }>(xs: T[]) => xs.filter((x) => urls.has(x.source_url));
  const recent_signals = cited(out.recent_signals);
  const possible_offers = cited(out.possible_offers);
  const attributes = dedupeAttributes(cited(out.attributes));
  const usedUrls = new Set([...recent_signals, ...possible_offers].map((x) => x.source_url));
  const enrichment: Enrichment = {
    status: "matched",
    identity_confidence: out.identity_confidence,
    identity_notes: out.identity_notes,
    summary: out.summary,
    recent_signals,
    possible_offers,
    attributes,
    sources: results.filter((r) => usedUrls.has(r.url) || usedUrls.size === 0).slice(0, 8).map((r) => ({ title: r.title, url: r.url })),
  };
  emit({ type: "result", enrichment });
  return enrichment;
}

export async function enrichAndSave(
  ctx: Ctx,
  contactId: string,
  opts: Parameters<typeof enrichContact>[1] = {},
): Promise<Enrichment> {
  const { db: supabase, ownerId } = ctx;
  const contact = must<Contact>(
    await supabase.from("contacts").select("*").eq("owner_id", ownerId).eq("id", contactId).single(),
  );
  // Only the final, identity-gated result is saved; partial output never reaches the database.
  const fresh = await enrichContact(contact, opts);
  // A refresh that can't confirm identity (e.g. a quiet news period) keeps the last good match.
  const enrichment =
    fresh.status === "no_confident_match" && contact.enrichment?.status === "matched" ? contact.enrichment : fresh;
  must(
    await supabase
      .from("contacts")
      .update({ enrichment, enriched_at: new Date().toISOString() })
      .eq("owner_id", ownerId)
      .eq("id", contactId),
  );
  return enrichment;
}

/**
 * Scheduled refresh across all accounts (service client; run by the cron route). Re-enriches contacts
 * never enriched or last enriched more than REFRESH_AFTER_DAYS ago, oldest first, up to `limit` per run.
 * Fictional demo contacts are skipped: searching them only finds namesakes.
 * Returns the owners whose contacts changed, so the caller can re-embed their documents.
 */
export async function refreshStaleEnrichment(
  opts: { limit?: number; concurrency?: number } = {},
): Promise<{ refreshed: number; failed: number; owners: string[] }> {
  if (!process.env.TAVILY_API_KEY) return { refreshed: 0, failed: 0, owners: [] };
  const cutoff = new Date(Date.now() - REFRESH_AFTER_DAYS * 86_400_000).toISOString();
  const due = must<{ id: string; owner_id: string; external_id: string | null }[]>(
    await serviceDb()
      .from("contacts")
      .select("id, owner_id, external_id")
      .or(`enriched_at.is.null,enriched_at.lt.${cutoff}`)
      .order("enriched_at", { ascending: true, nullsFirst: true })
      .limit(opts.limit ?? 200),
  ).filter((c) => !c.external_id || !DEMO_FICTIONAL_IDS.has(c.external_id));

  let failed = 0;
  const size = opts.concurrency ?? 5;
  for (let i = 0; i < due.length; i += size) {
    await Promise.all(
      due.slice(i, i + size).map((c) =>
        enrichAndSave({ db: serviceDb(), ownerId: c.owner_id }, c.id).catch((e) => {
          failed++;
          console.error(`Enrichment refresh failed for ${c.id}:`, e);
        }),
      ),
    );
  }
  return { refreshed: due.length - failed, failed, owners: [...new Set(due.map((c) => c.owner_id))] };
}

/** Enriches contacts that have never been enriched (or all, with force). */
export async function enrichPending(
  ctx: Ctx,
  opts: { force?: boolean; concurrency?: number } = {},
): Promise<number> {
  if (!process.env.TAVILY_API_KEY) return 0;
  let query = ctx.db.from("contacts").select("id").eq("owner_id", ctx.ownerId).order("id");
  if (!opts.force) query = query.is("enriched_at", null);
  const ids = must<{ id: string }[]>(await query).map((c) => c.id);
  const size = opts.concurrency ?? 5;
  for (let i = 0; i < ids.length; i += size) {
    await Promise.all(
      ids.slice(i, i + size).map((id) =>
        enrichAndSave(ctx, id).catch((e) => console.error(`Enrichment failed for ${id}:`, e)),
      ),
    );
  }
  return ids.length;
}

function dedupeAttributes(attrs: Attribute[]): Attribute[] {
  const seen = new Set<string>();
  return attrs.filter((a) => {
    const key = a.label.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

/** One line for prompts. Clearly labeled as unverified public info. */
export function enrichmentLine(e: Enrichment | null): string | null {
  if (!e || e.status !== "matched") return null;
  const parts = [e.summary, ...e.recent_signals.map((s) => `${s.date ?? "recent"}: ${s.text}`)];
  if (e.possible_offers.length) parts.push(`can offer: ${e.possible_offers.map((o) => o.text).join("; ")}`);
  if (e.attributes?.length) parts.push(`tags: ${e.attributes.map((a) => a.label).join(", ")}`);
  return `public web (unverified, ${e.identity_confidence} identity confidence): ${parts.join(" | ")}`;
}
