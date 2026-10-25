import Papa from "papaparse";

// Phone numbers and emails from the user's own address book: a vCard export (iPhone/iCloud,
// macOS Contacts, Android) or a Google Contacts CSV. LinkedIn exports carry neither.
// Only fills in contacts already in the network: address books hold plumbers and dentists too,
// so nobody is added from one. Pure functions, no server imports.
// Phone and email are private (docs/data-contract.md): never sent to Claude or Tavily.

export type PhonebookEntry = { name: string; emails: string[]; phones: string[]; company: string | null };

/** Assumed country code for numbers without one (10-digit North American numbers). */
const DEFAULT_COUNTRY_CODE = "1";

/** E.164-style "+15555550100", or null if it doesn't look like a phone number. */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (trimmed.startsWith("00")) return digits.length >= 10 ? `+${digits.slice(2)}` : null;
  if (digits.length === 10) return `+${DEFAULT_COUNTRY_CODE}${digits}`;
  if (digits.length === 11 && digits.startsWith(DEFAULT_COUNTRY_CODE)) return `+${digits}`;
  return null;
}

const normEmail = (e: string) => e.trim().toLowerCase();
const isEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/** "Dr. Tom O'Brien, CPA" → "tom o'brien" */
export function normName(name: string): string {
  return name
    .toLowerCase()
    .replace(/(,\s*[a-z.]{1,7})+$/, "")
    .replace(/^(dr|mr|mrs|ms|prof)\.?\s+/, "")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const firstLast = (n: string) => {
  const parts = normName(n).split(" ");
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]}` : parts[0];
};

// ---------- vCard ----------

function parseVCard(text: string): PhonebookEntry[] {
  // Unfold continuation lines (RFC 6350 §3.2), then split into cards.
  const lines = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const entries: PhonebookEntry[] = [];
  let cur: { fn?: string; n?: string; org?: string; emails: string[]; phones: string[] } | null = null;
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    // "item1.TEL;type=CELL" → "TEL"
    const prop = line.slice(0, idx).split(";")[0].replace(/^item\d+\./i, "").toUpperCase();
    const value = line.slice(idx + 1).replace(/\\,/g, ",").replace(/\\;/g, ";").trim();
    if (prop === "BEGIN" && value.toUpperCase() === "VCARD") cur = { emails: [], phones: [] };
    else if (!cur) continue;
    else if (prop === "END") {
      const name = cur.fn || (cur.n ? cur.n.split(";").slice(0, 2).reverse().join(" ").trim() : "");
      if (name) entries.push({ name, emails: cur.emails, phones: cur.phones, company: cur.org || null });
      cur = null;
    } else if (prop === "FN") cur.fn = value;
    else if (prop === "N") cur.n = value;
    else if (prop === "ORG") cur.org = value.split(";")[0];
    else if (prop === "EMAIL" && isEmail(value)) cur.emails.push(normEmail(value));
    else if (prop === "TEL") {
      const p = normalizePhone(value.replace(/^tel:/i, ""));
      if (p) cur.phones.push(p);
    }
  }
  return entries;
}

// ---------- Google Contacts CSV ----------

function parseGoogleCsv(text: string): PhonebookEntry[] | null {
  const { data } = Papa.parse<Record<string, string>>(text.replace(/^﻿/, "").trim(), { header: true, skipEmptyLines: true });
  const headers = Object.keys(data[0] ?? {});
  const phoneCols = headers.filter((h) => /^Phone \d+ - Value$/i.test(h));
  const emailCols = headers.filter((h) => /^E-mail \d+ - Value$/i.test(h));
  if (!phoneCols.length && !emailCols.length) return null;

  // Google splits multiple values in one cell with " ::: ".
  const values = (r: Record<string, string>, cols: string[]) => cols.flatMap((c) => (r[c] ?? "").split(":::")).map((v) => v.trim()).filter(Boolean);
  return data
    .map((r) => {
      // Current export: First/Middle/Last Name + Organization Name; older export: Name/Given Name + Organization 1 - Name.
      const name = (r["Name"] || [r["First Name"] ?? r["Given Name"], r["Last Name"] ?? r["Family Name"]].filter(Boolean).join(" ")).trim();
      return {
        name,
        emails: values(r, emailCols).filter(isEmail).map(normEmail),
        phones: values(r, phoneCols).map(normalizePhone).filter((p): p is string => !!p),
        company: (r["Organization Name"] || r["Organization 1 - Name"] || "").trim() || null,
      };
    })
    .filter((e) => e.name && (e.phones.length || e.emails.length));
}

/** Parses a vCard (.vcf) or Google Contacts CSV. Returns null if the file is neither. */
export function parsePhonebook(text: string): { format: "vcard" | "google_csv"; entries: PhonebookEntry[] } | null {
  if (/BEGIN:VCARD/i.test(text)) return { format: "vcard", entries: parseVCard(text) };
  const google = parseGoogleCsv(text);
  return google ? { format: "google_csv", entries: google } : null;
}

// ---------- Matching ----------

export type MatchableContact = { id: string; name: string; company: string | null; phone: string | null; email: string | null };
export type PhonebookUpdate = { id: string; phone?: string; email?: string };
export type PhonebookResult = {
  updates: PhonebookUpdate[];
  /** Contacts with more than one plausible address-book entry: left alone, listed for the user. */
  ambiguous: string[];
  entries: number;
};

/**
 * Matches address-book entries to existing contacts: by email first, then exact full name,
 * then first + last name. A company match breaks ties between same-named entries.
 * Only fills empty fields; numbers and emails the user already has are never overwritten.
 */
export function matchPhonebook(contacts: MatchableContact[], entries: PhonebookEntry[]): PhonebookResult {
  const byEmail = new Map<string, PhonebookEntry[]>();
  const byName = new Map<string, PhonebookEntry[]>();
  const byFirstLast = new Map<string, PhonebookEntry[]>();
  const add = (m: Map<string, PhonebookEntry[]>, k: string, e: PhonebookEntry) => k && m.set(k, [...(m.get(k) ?? []), e]);
  for (const e of entries) {
    for (const em of e.emails) add(byEmail, em, e);
    add(byName, normName(e.name), e);
    add(byFirstLast, firstLast(e.name), e);
  }

  const updates: PhonebookUpdate[] = [];
  const ambiguous: string[] = [];
  for (const c of contacts) {
    if (c.phone && c.email) continue;
    let candidates = (c.email && byEmail.get(normEmail(c.email))) || byName.get(normName(c.name)) || byFirstLast.get(firstLast(c.name)) || [];
    if (candidates.length > 1 && c.company) {
      const sameCompany = candidates.filter((e) => e.company && normName(e.company) === normName(c.company!));
      if (sameCompany.length) candidates = sameCompany;
    }
    if (!candidates.length) continue;
    const phones = new Set(candidates.flatMap((e) => e.phones.slice(0, 1)));
    const emails = new Set(candidates.flatMap((e) => e.emails.slice(0, 1)));
    if (candidates.length > 1 && (phones.size > 1 || emails.size > 1)) {
      ambiguous.push(c.name);
      continue;
    }
    const e = candidates[0];
    const u: PhonebookUpdate = { id: c.id };
    if (!c.phone && e.phones[0]) u.phone = e.phones[0];
    if (!c.email && e.emails[0]) u.email = e.emails[0];
    if (u.phone || u.email) updates.push(u);
  }
  return { updates, ambiguous, entries: entries.length };
}

/** WhatsApp link with the message prefilled. Without a number, WhatsApp asks who to send it to. */
export function whatsappLink(phone: string | null, text?: string): string {
  const q = text ? `?text=${encodeURIComponent(text)}` : "";
  return `https://wa.me/${phone ? phone.replace(/\D/g, "") : ""}${q}`;
}
