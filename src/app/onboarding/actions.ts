"use server";

import { redirect } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { buildBriefing, defaultEvalDate } from "@/lib/briefing";
import { hasDemoData, loadDemoData } from "@/lib/demo";
import { ensureDrafts } from "@/lib/draft";
import { enrichAndSave } from "@/lib/enrich";
import { ingestNote } from "@/lib/extract";
import { findIntroductions } from "@/lib/match";
import { getProfile, GOALS, INDUSTRIES, OFFERS, REVENUE, ROLES, saveProfile, type Profile } from "@/lib/profile";
import { must } from "@/lib/supabase";
import type { Contact } from "@/lib/types";

// Onboarding runs as a series of small server actions so the client can show progress between them.
// Every action resolves the signed-in user; contacts and notes are always written under their owner_id.

const MAX_ROWS = 500;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const clamp = (n: unknown, lo: number, hi: number, fallback: number) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
};
const pick = (xs: unknown, allowed: readonly string[]) =>
  Array.isArray(xs) ? [...new Set(xs.map(String).filter((x) => allowed.includes(x)))] : [];

export async function saveAnswersAction(answers: Partial<Profile>): Promise<void> {
  const ctx = await requireCtx();
  const patch: Partial<Profile> = {};
  if ("full_name" in answers) patch.full_name = String(answers.full_name ?? "").trim().replace(/\s+/g, " ").slice(0, 80) || null;
  if ("offers" in answers) patch.offers = pick(answers.offers, OFFERS.map(([id]) => id));
  if ("offer_line" in answers) patch.offer_line = String(answers.offer_line ?? "").trim().slice(0, 200) || null;
  if ("goal" in answers) patch.goal = GOALS.find((g) => g.id === answers.goal)?.id ?? null;
  if ("industries" in answers) patch.industries = pick(answers.industries, INDUSTRIES);
  if ("roles" in answers) patch.roles = pick(answers.roles, ROLES.map(([id]) => id));
  if ("revenue" in answers) {
    const rev = pick(answers.revenue, REVENUE.map(([id]) => id));
    patch.revenue = rev.length ? rev : ["any"];
  }
  if ("per_day" in answers) patch.per_day = clamp(answers.per_day, 1, 10, 5);
  if ("asks_per_week" in answers) patch.asks_per_week = clamp(answers.asks_per_week, 0, 5, 2);
  if ("gives_per_ask" in answers) patch.gives_per_ask = clamp(answers.gives_per_ask, 0, 5, 2);
  if ("rest_days" in answers) patch.rest_days = clamp(answers.rest_days, 1, 90, 14);
  if ("tone" in answers && ["warm", "professional", "brief"].includes(String(answers.tone))) patch.tone = answers.tone;
  const before = VOICE_FIELDS.some((k) => k in patch) ? await getProfile(ctx) : null;
  await saveProfile(ctx, patch);

  // Drafts are written in the user's voice; if that changed, clear unsent drafts so they're rewritten.
  if (before && VOICE_FIELDS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(patch[k]))) {
    must(
      await ctx.db
        .from("opportunities")
        .update({ draft_message: null, draft_kind: null })
        .eq("owner_id", ctx.ownerId)
        .neq("status", "completed"),
    );
    must(await ctx.db.from("contacts").update({ outreach_draft: null }).eq("owner_id", ctx.ownerId));
  }
}

/** Profile fields that change how drafted messages read. */
const VOICE_FIELDS = ["full_name", "tone", "offers", "offer_line"] as const;

export type MappedContact = {
  name: string;
  company?: string;
  title?: string;
  industry?: string;
  strength?: number;
  notes?: string;
  last_contacted?: string;
  introduction_preferences?: string;
};

export type NoteJob = { id: string; date: string; notes: string };

/** Upserts mapped CSV rows. Re-uploading the same person (name + company) updates rather than duplicates. */
export async function importContactsAction(
  rows: MappedContact[],
): Promise<{ imported: number; contactIds: string[]; noteJobs: NoteJob[] }> {
  const ctx = await requireCtx();
  const today = defaultEvalDate();
  const clean = rows
    .slice(0, MAX_ROWS)
    .map((r) => ({ ...r, name: String(r.name ?? "").trim().slice(0, 120) }))
    .filter((r) => r.name);
  if (!clean.length) return { imported: 0, contactIds: [], noteJobs: [] };

  // Same person = same normalized name + company, however they were first added
  // (demo, the Add contact form, an earlier CSV or LinkedIn import).
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const key = (name: string, company: string | null | undefined) => `${norm(name)}|${norm(company)}`;
  const text = (s: string | undefined, max: number) => (s ?? "").trim().slice(0, max) || null;
  const byKey = new Map(clean.map((r) => [key(r.name, r.company), r])); // last row wins for duplicate people

  const existing = must<Contact[]>(await ctx.db.from("contacts").select("*").eq("owner_id", ctx.ownerId));
  const existingByKey = new Map(existing.map((c) => [key(c.name, c.company), c]));

  const idFor = new Map<string, string>();
  const inserts: Record<string, unknown>[] = [];
  for (const [k, r] of byKey) {
    const lastContacted = r.last_contacted && ISO.test(r.last_contacted) ? r.last_contacted : null;
    const match = existingByKey.get(k);
    if (!match) {
      inserts.push({
        owner_id: ctx.ownerId,
        external_id: `csv:${k}`,
        name: r.name,
        company: text(r.company, 120),
        title: text(r.title, 120),
        industry: text(r.industry, 80),
        relationship_strength: clamp(r.strength, 1, 5, 3),
        last_interaction_date: lastContacted,
        introduction_preferences: text(r.introduction_preferences, 300),
      });
      continue;
    }
    // Existing person: fill gaps and take newer facts from the file, never blank anything out.
    idFor.set(k, match.id);
    const patch: Partial<Contact> = {};
    if (!match.title && text(r.title, 120)) patch.title = text(r.title, 120);
    if (!match.industry && text(r.industry, 80)) patch.industry = text(r.industry, 80);
    if (!match.introduction_preferences && text(r.introduction_preferences, 300))
      patch.introduction_preferences = text(r.introduction_preferences, 300);
    if (r.strength !== undefined) patch.relationship_strength = clamp(r.strength, 1, 5, match.relationship_strength);
    if (lastContacted && (!match.last_interaction_date || lastContacted > match.last_interaction_date))
      patch.last_interaction_date = lastContacted;
    if (Object.keys(patch).length) {
      must(await ctx.db.from("contacts").update(patch).eq("owner_id", ctx.ownerId).eq("id", match.id));
    }
  }

  if (inserts.length) {
    const saved = must<{ id: string; external_id: string }[]>(
      await ctx.db
        .from("contacts")
        .upsert(inserts, { onConflict: "owner_id,external_id", ignoreDuplicates: true })
        .select("id, external_id"),
    );
    for (const c of saved) idFor.set(c.external_id.replace(/^csv:/, ""), c.id);
  }

  const noteJobs = [...byKey.entries()].flatMap(([k, r]) => {
    const notes = (r.notes ?? "").trim().slice(0, 4000);
    const id = idFor.get(k);
    if (!id || notes.length < 15) return [];
    const date = r.last_contacted && ISO.test(r.last_contacted) && r.last_contacted <= today ? r.last_contacted : today;
    return [{ id, date, notes }];
  });
  return { imported: idFor.size, contactIds: [...idFor.values()], noteJobs };
}

/** Runs Claude extraction on a batch of notes, in parallel. Skips notes that were already logged. */
export async function extractNotesAction(jobs: NoteJob[]): Promise<{ done: number; failed: number }> {
  const ctx = await requireCtx();
  const results = await Promise.allSettled(
    jobs.slice(0, 8).map(async (j) => {
      const { count } = await ctx.db
        .from("interactions")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", ctx.ownerId)
        .eq("contact_id", j.id)
        .eq("raw_notes", j.notes);
      if (!count) await ingestNote(ctx, j.id, ISO.test(j.date) ? j.date : defaultEvalDate(), j.notes);
    }),
  );
  return { done: results.filter((r) => r.status === "fulfilled").length, failed: results.filter((r) => r.status === "rejected").length };
}

/** Web enrichment (Tavily + Claude) for a batch of contacts that haven't been enriched yet. */
export async function enrichContactsAction(ids: string[]): Promise<{ done: number; matched: number }> {
  const ctx = await requireCtx();
  if (!process.env.TAVILY_API_KEY) return { done: 0, matched: 0 };
  const pending = must<{ id: string }[]>(
    await ctx.db
      .from("contacts")
      .select("id")
      .eq("owner_id", ctx.ownerId)
      .in("id", ids.slice(0, 8))
      .is("enriched_at", null),
  );
  const results = await Promise.allSettled(pending.map((c) => enrichAndSave(ctx, c.id)));
  return {
    done: results.length,
    matched: results.filter((r) => r.status === "fulfilled" && r.value.status === "matched").length,
  };
}

export async function findIntroductionsStepAction(): Promise<void> {
  const ctx = await requireCtx();
  await findIntroductions(ctx);
}

/** Drafting is a nice-to-have at setup: if Claude is unavailable, Today writes drafts on first view instead. */
export async function draftMessagesStepAction(): Promise<{ ok: boolean }> {
  const ctx = await requireCtx();
  try {
    await ensureDrafts(ctx, defaultEvalDate());
    return { ok: true };
  } catch (e) {
    console.error("Onboarding drafting skipped:", e);
    return { ok: false };
  }
}

export async function loadDemoNetworkAction(): Promise<{ contacts: number }> {
  const ctx = await requireCtx();
  if (!(await hasDemoData(ctx))) await loadDemoData(ctx);
  const { count } = await ctx.db.from("contacts").select("id", { count: "exact", head: true }).eq("owner_id", ctx.ownerId);
  return { contacts: count ?? 0 };
}

export type OnboardingSummary = {
  contacts: number;
  needs: number;
  enriched: number;
  intros: number;
  top: { recipient: string; proposed: string; need: string; why: string }[];
};

export async function summaryAction(): Promise<OnboardingSummary> {
  const ctx = await requireCtx();
  const head = (table: string) =>
    ctx.db.from(table).select("id", { count: "exact", head: true }).eq("owner_id", ctx.ownerId);
  const [contacts, needs, enriched, briefing] = await Promise.all([
    head("contacts").then((r) => r.count ?? 0),
    head("signals").eq("type", "need").eq("status", "active").then((r) => r.count ?? 0),
    head("contacts").eq("enrichment->>status", "matched").then((r) => r.count ?? 0),
    buildBriefing(ctx, defaultEvalDate()),
  ]);
  return {
    contacts,
    needs,
    enriched,
    intros: briefing.recommendations.length + briefing.alsoConsidered.length,
    top: briefing.recommendations.slice(0, 4).map((c) => ({
      recipient: c.recipient.name,
      proposed: c.proposed.name,
      need: c.need.description,
      why: c.opp.why_proposed,
    })),
  };
}

export async function completeOnboardingAction(): Promise<void> {
  const ctx = await requireCtx();
  await saveProfile(ctx, { onboarded_at: new Date().toISOString() });
  redirect("/");
}
