import Papa from "papaparse";
import { LINKEDIN_MAX, parseLinkedInConnections } from "./linkedin";
import { must, type Ctx } from "./supabase";

// FR-01: CSV import. Columns: contact_id,name,company,title,industry,
// relationship_strength,last_interaction_date,introduction_preferences

export async function importContactsCsv(ctx: Ctx, csv: string): Promise<number> {
  const linkedin = parseLinkedInConnections(csv);
  if (linkedin) return importLinkedIn(ctx, linkedin.slice(0, LINKEDIN_MAX));

  const parsed = Papa.parse<Record<string, string>>(csv.trim(), { header: true, skipEmptyLines: true });
  if (parsed.errors.length) throw new Error(`CSV error: ${parsed.errors[0].message}`);

  const rows = parsed.data.map((r, i) => {
    const id = r.contact_id?.trim();
    const name = r.name?.trim();
    if (!id || !name) throw new Error(`Row ${i + 2}: contact_id and name are required`);
    const strength = Number(r.relationship_strength);
    const date = r.last_interaction_date?.trim();
    return {
      owner_id: ctx.ownerId,
      external_id: id,
      name,
      company: r.company?.trim() || null,
      title: r.title?.trim() || null,
      industry: r.industry?.trim() || null,
      relationship_strength: Number.isInteger(strength) && strength >= 1 && strength <= 5 ? strength : 3,
      last_interaction_date: /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? date : null,
      introduction_preferences: r.introduction_preferences?.trim() || null,
    };
  });

  // Matched on (owner, contact_id): re-importing updates rather than duplicates.
  must(await ctx.db.from("contacts").upsert(rows, { onConflict: "owner_id,external_id" }));
  return rows.length;
}

/**
 * LinkedIn Connections.csv: adds people who aren't in the network yet and leaves existing contacts
 * untouched (their relationship strength and history matter more than a LinkedIn row). Keyed like
 * onboarding's import, so the same person is never added twice through either path.
 */
async function importLinkedIn(ctx: Ctx, connections: NonNullable<ReturnType<typeof parseLinkedInConnections>>) {
  // Contacts added other ways (demo, manual, other CSVs) have other external ids, so also match on name + company.
  // Same normalization as onboarding's import: trim, lowercase, collapse whitespace.
  const norm = (v: string | null) => (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const key = (name: string, company: string | null) => `${norm(name)}|${norm(company)}`;
  const existing = must<{ name: string; company: string | null }[]>(
    await ctx.db.from("contacts").select("name, company").eq("owner_id", ctx.ownerId),
  );
  const known = new Set(existing.map((c) => key(c.name, c.company)));
  const fresh = connections.filter((c) => !known.has(key(c.name, c.company)));
  const rows = new Map(
    fresh.map((c) => [
      `csv:${key(c.name, c.company)}`,
      {
        owner_id: ctx.ownerId,
        name: c.name.slice(0, 120),
        company: c.company?.slice(0, 120) ?? null,
        title: c.title?.slice(0, 120) ?? null,
        // A LinkedIn connection alone is a weak tie; the user can raise it per contact.
        relationship_strength: 2,
        last_interaction_date: null,
      },
    ]),
  );
  must(
    await ctx.db.from("contacts").upsert(
      [...rows].map(([external_id, r]) => ({ ...r, external_id })),
      { onConflict: "owner_id,external_id", ignoreDuplicates: true },
    ),
  );
  return rows.size;
}
