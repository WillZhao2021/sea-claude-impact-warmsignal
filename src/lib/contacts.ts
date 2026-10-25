import Papa from "papaparse";
import { guessColumns, parseCsv, statusLabels, toContacts } from "@/components/onboarding/csv";
import { LINKEDIN_MAX, parseLinkedInConnections } from "./linkedin";
import { matchPhonebook, parsePhonebook, type PhonebookResult } from "./phonebook";
import { must, type Ctx } from "./supabase";

// FR-01: CSV import, three ways:
// - Daily Networker's own format (has contact_id): contact_id,name,company,title,industry,
//   relationship_strength,last_interaction_date,introduction_preferences. Upserts by contact_id.
// - A LinkedIn connection list (official export or a tool's export): adds new people only.
// - Any other CSV with a name column: columns guessed like onboarding's import; adds new people only.
// Returns how many contacts were added or updated. Throws ImportError with a message for the user.

export class ImportError extends Error {}

/** Same cap as LinkedIn imports, so one upload can't create thousands of contacts to enrich. */
const IMPORT_MAX = LINKEDIN_MAX;

export async function importContactsCsv(ctx: Ctx, csv: string): Promise<number> {
  const linkedin = parseLinkedInConnections(csv);
  if (linkedin) {
    if (!linkedin.length) throw new ImportError("That LinkedIn file has no connections in it.");
    // A LinkedIn connection alone is a weak tie; the user can raise it per contact.
    return importNew(
      ctx,
      linkedin.slice(0, LINKEDIN_MAX).map((c) => ({ name: c.name, company: c.company, title: c.title, strength: 2 })),
    );
  }

  const parsed = Papa.parse<Record<string, string>>(csv.replace(/^\uFEFF/, "").trim(), { header: true, skipEmptyLines: true });
  if (!parsed.meta.fields?.map((f) => f.trim()).includes("contact_id")) return importGuessed(ctx, csv);
  if (parsed.errors.length) throw new ImportError(`CSV error on row ${(parsed.errors[0].row ?? 0) + 2}: ${parsed.errors[0].message}`);

  const rows = parsed.data.map((r, i) => {
    const id = r.contact_id?.trim();
    const name = r.name?.trim();
    if (!id || !name) throw new ImportError(`Row ${i + 2}: contact_id and name are required`);
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

/** Any CSV with a name column. Notes columns are ignored here: onboarding's import handles those with extraction. */
async function importGuessed(ctx: Ctx, csv: string): Promise<number> {
  const file = parseCsv("import.csv", csv);
  if ("error" in file) throw new ImportError(file.error);
  const map = guessColumns(file.header);
  if (map.name < 0) {
    throw new ImportError(
      `Couldn't find a name column. The file's columns are: ${file.header.slice(0, 8).join(", ")}. Add a "Name" column and try again.`,
    );
  }
  const contacts = toContacts(file, map, statusLabels(file, map.status)).filter((c) => c.name && !/^[=+@-]/.test(c.name));
  if (!contacts.length) throw new ImportError("That file has no contacts with a name.");
  return importNew(
    ctx,
    contacts.slice(0, IMPORT_MAX).map((c) => ({
      name: c.name,
      company: c.company ?? null,
      title: c.title ?? null,
      industry: c.industry ?? null,
      strength: c.strength ?? 3,
      last_interaction_date: c.last_contacted ?? null,
      introduction_preferences: c.introduction_preferences ?? null,
    })),
  );
}

type NewContact = {
  name: string;
  company: string | null;
  title: string | null;
  industry?: string | null;
  strength: number;
  last_interaction_date?: string | null;
  introduction_preferences?: string | null;
};

/**
 * Adds people who aren't in the network yet and leaves existing contacts untouched (their
 * relationship strength and history matter more than a CSV row). Keyed like onboarding's import,
 * so the same person is never added twice through either path. Returns how many were added.
 */
async function importNew(ctx: Ctx, people: NewContact[]): Promise<number> {
  // Contacts added other ways (demo, manual, other CSVs) have other external ids, so also match on name + company.
  // Same normalization as onboarding's import: trim, lowercase, collapse whitespace.
  const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const key = (name: string, company: string | null) => `${norm(name)}|${norm(company)}`;
  const existing = must<{ name: string; company: string | null }[]>(
    await ctx.db.from("contacts").select("name, company").eq("owner_id", ctx.ownerId),
  );
  const known = new Set(existing.map((c) => key(c.name, c.company)));
  const rows = new Map(
    people
      .filter((c) => !known.has(key(c.name, c.company)))
      .map((c) => [
        `csv:${key(c.name, c.company)}`,
        {
          owner_id: ctx.ownerId,
          name: c.name.slice(0, 120),
          company: c.company?.slice(0, 120) ?? null,
          title: c.title?.slice(0, 120) ?? null,
          industry: c.industry?.slice(0, 120) ?? null,
          relationship_strength: Math.min(5, Math.max(1, Math.round(c.strength) || 2)),
          last_interaction_date: c.last_interaction_date ?? null,
          introduction_preferences: c.introduction_preferences?.slice(0, 500) ?? null,
        },
      ]),
  );
  if (!rows.size) return 0;
  must(
    await ctx.db.from("contacts").upsert(
      [...rows].map(([external_id, r]) => ({ ...r, external_id })),
      { onConflict: "owner_id,external_id", ignoreDuplicates: true },
    ),
  );
  return rows.size;
}

/**
 * Address-book import (vCard or Google Contacts CSV): fills in phone and email on contacts already
 * in the network. Never creates contacts and never overwrites a number or email already saved.
 */
export async function importPhonebook(
  ctx: Ctx,
  text: string,
): Promise<Omit<PhonebookResult, "updates"> & { updated: number }> {
  const book = parsePhonebook(text);
  if (!book) throw new Error("That file isn't a vCard (.vcf) or a Google Contacts CSV export");
  const contacts = must<{ id: string; name: string; company: string | null; phone: string | null; email: string | null }[]>(
    await ctx.db.from("contacts").select("id, name, company, phone, email").eq("owner_id", ctx.ownerId),
  );
  const { updates, ambiguous, entries } = matchPhonebook(contacts, book.entries);
  for (let i = 0; i < updates.length; i += 20) {
    await Promise.all(
      updates.slice(i, i + 20).map(({ id, ...patch }) =>
        ctx.db.from("contacts").update(patch).eq("owner_id", ctx.ownerId).eq("id", id).then(must),
      ),
    );
  }
  return { updated: updates.length, ambiguous, entries };
}
