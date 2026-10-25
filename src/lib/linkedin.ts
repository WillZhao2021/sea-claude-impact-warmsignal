import Papa from "papaparse";

// LinkedIn connection lists, in two formats:
// - LinkedIn's official data export (Settings → Data privacy → Get a copy of your data → Connections).
//   Connections.csv starts with a "Notes:" preamble before the real header row:
//     First Name,Last Name,URL,Email Address,Company,Position,Connected On
// - Exports from scraping tools and browser extensions:
//     Name,Current Company,Current Role,Previous Companies
//   where Name is often a spreadsheet formula: =HYPERLINK("https://www.linkedin.com/in/…","Jane Doe").
// Pure parsing, no server imports: used by onboarding (in the browser) and the Contacts import.

export const LINKEDIN_EXPORT_URL = "https://www.linkedin.com/mypreferences/d/download-my-data";

/** Same cap as onboarding's import; the most recent connections are kept. */
export const LINKEDIN_MAX = 500;

export type LinkedInConnection = {
  name: string;
  company: string | null;
  title: string | null;
  url: string | null;
  /** When you connected. Not an interaction, so never used as "last spoke". */
  connected_on: string | null;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function isoDate(value: string): string | null {
  const v = value.trim();
  const m = v.match(/^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -](\d{4})$/); // "15 Mar 2024"
  if (m) {
    const month = MONTHS.indexOf(m[2].toLowerCase());
    if (month >= 0) return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return null;
}

/** "Tom O'Brien, CPA" → "Tom O'Brien": credentials are common in LinkedIn names but aren't part of the name. */
function cleanName(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/(,\s*[A-Z][A-Za-z.]{1,7})+$/, "")
    .trim();
}

/** =HYPERLINK("url","label") → { url, label }. Any other value is returned as the label. */
function unwrapHyperlink(value: string): { label: string; url: string | null } {
  const m = value.trim().match(/^=HYPERLINK\(\s*"([^"]*)"\s*[,;]\s*"([^"]*)"\s*\)$/i);
  return m ? { label: m[2], url: m[1] || null } : { label: value, url: null };
}

/** Parses a LinkedIn connection list, newest connections first. Returns null for any other CSV. */
export function parseLinkedInConnections(text: string): LinkedInConnection[] | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const headerAt = lines.findIndex((l) => /^"?first name"?\s*,\s*"?last name"?\s*,/i.test(l.trim()));
  if (headerAt < 0) return parseToolExport(lines);

  const parsed = Papa.parse<Record<string, string>>(lines.slice(headerAt).join("\n"), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  const get = (r: Record<string, string>, key: string) => (r[key] ?? "").trim();
  return parsed.data
    .map((r) => ({
      name: cleanName(`${get(r, "first name")} ${get(r, "last name")}`),
      company: get(r, "company") || null,
      title: get(r, "position") || null,
      url: get(r, "url") || null,
      connected_on: isoDate(get(r, "connected on")),
    }))
    .filter((c) => c.name)
    .sort((a, b) => (b.connected_on ?? "").localeCompare(a.connected_on ?? ""));
}

/** Name,Current Company,Current Role[,Previous Companies]: kept in file order (no connection dates). */
function parseToolExport(lines: string[]): LinkedInConnection[] | null {
  const header = Papa.parse<string[]>(lines[0] ?? "").data[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  if (!header.includes("name") || !(header.includes("current company") || header.includes("current role"))) return null;

  const parsed = Papa.parse<Record<string, string>>(lines.join("\n"), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  const get = (r: Record<string, string>, key: string) => (r[key] ?? "").trim();
  return parsed.data
    .map((r) => {
      const { label, url } = unwrapHyperlink(get(r, "name"));
      return {
        name: cleanName(label),
        company: get(r, "current company") || null,
        title: get(r, "current role") || null,
        url,
        connected_on: null,
      };
    })
    // A name that is still a formula (or starts like one) isn't a name.
    .filter((c) => c.name && !/^[=+@-]/.test(c.name));
}
