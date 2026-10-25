import Papa from "papaparse";
import type { MappedContact } from "@/app/onboarding/actions";
import { LINKEDIN_MAX, parseLinkedInConnections } from "@/lib/linkedin";

// Client-side CSV handling for onboarding: parse, guess which column is which, and map
// relationship labels ("warm", "referral", "4") onto Daily Networker's 1–5 relationship strength.

export const FIELDS = [
  { key: "name", label: "Name", required: true },
  { key: "company", label: "Company" },
  { key: "title", label: "Job title" },
  { key: "industry", label: "Industry" },
  { key: "status", label: "Relationship" },
  { key: "notes", label: "Notes" },
  { key: "last_contacted", label: "Last contacted" },
  { key: "introduction_preferences", label: "Intro preferences" },
] as const;

export type FieldKey = (typeof FIELDS)[number]["key"];
export type ColumnMap = Record<FieldKey, number>; // -1 = not in file

const GUESS: Record<FieldKey, RegExp> = {
  name: /^(full ?name|name|contact( name)?)$/i,
  company: /^(company|organi[sz]ation|company name|employer|account|current company)$/i,
  title: /^(title|job title|position|role|current role|current title|headline)$/i,
  industry: /^(industry|sector|vertical)$/i,
  status: /^(status|warmth|relationship( strength)?|temperature|strength|tier)$/i,
  notes: /^(notes?|owner notes|comments?|context|description)$/i,
  last_contacted: /^(last (contacted|interaction|meeting|touch)( date)?|last_interaction_date|date)$/i,
  introduction_preferences: /^(intro(duction)?[ _]?preferences|preferences)$/i,
};

export type Warmth = "cold" | "warm" | "close";
export const WARMTH: { id: Warmth; label: string; strength: number }[] = [
  { id: "cold", label: "Cold", strength: 2 },
  { id: "warm", label: "Warm", strength: 3 },
  { id: "close", label: "Close", strength: 4 },
];

export type ParsedCsv = {
  fileName: string;
  header: string[];
  rows: string[][];
  /** Set for LinkedIn's Connections.csv export: total connections in the file, before the cap. */
  linkedin?: { total: number };
};

export function parseCsv(fileName: string, text: string): ParsedCsv | { error: string } {
  // LinkedIn's export has a preamble and split names; turn it into columns guessColumns recognizes.
  const linkedin = parseLinkedInConnections(text);
  if (linkedin) {
    if (!linkedin.length) return { error: "That LinkedIn export has no connections in it." };
    return {
      fileName,
      header: ["Name", "Company", "Position", "Relationship", "Connected On", "LinkedIn URL"],
      rows: linkedin
        .slice(0, LINKEDIN_MAX)
        .map((c) => [c.name, c.company ?? "", c.title ?? "", "LinkedIn connection", c.connected_on ?? "", c.url ?? ""]),
      linkedin: { total: linkedin.length },
    };
  }
  const out = Papa.parse<string[]>(text.replace(/^﻿/, ""), { skipEmptyLines: "greedy" });
  const rows = out.data.filter((r) => r.some((c) => c.trim()));
  if (rows.length < 2) return { error: "That file has no contact rows. The first row should be headers, with one contact per row below." };
  return { fileName, header: rows[0].map((h) => h.trim()), rows: rows.slice(1) };
}

export function guessColumns(header: string[]): ColumnMap {
  const map = Object.fromEntries(FIELDS.map((f) => [f.key, header.findIndex((h) => GUESS[f.key].test(h))])) as ColumnMap;
  if (map.name < 0) map.name = header.findIndex((h) => /name/i.test(h));
  if (map.notes < 0) map.notes = header.findIndex((h) => /note/i.test(h));
  return map;
}

export function guessWarmth(value: string): Warmth | number {
  const v = value.trim().toLowerCase();
  const n = Number(v);
  if (Number.isInteger(n) && n >= 1 && n <= 5) return n;
  if (/ref|close|friend|strong|hot|trusted|client/.test(v)) return "close";
  if (/warm|good|know|met|acquaint/.test(v)) return "warm";
  return "cold";
}

/** Distinct non-numeric relationship labels in the file, with a guessed warmth for each. */
export function statusLabels(csv: ParsedCsv, col: number): Record<string, Warmth> {
  if (col < 0) return {};
  const labels: Record<string, Warmth> = {};
  for (const r of csv.rows) {
    const v = (r[col] ?? "").trim();
    const g = v ? guessWarmth(v) : null;
    if (v && typeof g === "string" && !(v in labels)) labels[v] = g;
  }
  return labels;
}

function isoDate(value: string): string | undefined {
  const v = value.trim();
  if (!v) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

export function toContacts(csv: ParsedCsv, map: ColumnMap, labels: Record<string, Warmth>): MappedContact[] {
  const get = (r: string[], k: FieldKey) => (map[k] >= 0 ? (r[map[k]] ?? "").trim() : "");
  return csv.rows
    .map((r) => {
      const status = get(r, "status");
      const guess = status ? guessWarmth(status) : null;
      // No relationship column: leave strength unset (new people default to Warm; existing ones keep theirs).
      const strength =
        map.status < 0
          ? undefined
          : typeof guess === "number"
            ? guess
            : WARMTH.find((w) => w.id === (labels[status] ?? guess ?? "warm"))!.strength;
      return {
        name: get(r, "name"),
        company: get(r, "company") || undefined,
        title: get(r, "title") || undefined,
        industry: get(r, "industry") || undefined,
        strength,
        notes: get(r, "notes") || undefined,
        last_contacted: isoDate(get(r, "last_contacted")),
        introduction_preferences: get(r, "introduction_preferences") || undefined,
      };
    })
    .filter((c) => c.name);
}
