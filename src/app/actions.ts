"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { requireCtx, userDb } from "@/lib/auth";
import { defaultEvalDate } from "@/lib/briefing";
import { getOrCreateCatchUpDraft, recordDecision, type CatchUpDecision } from "@/lib/catch-up";
import { importContactsCsv } from "@/lib/contacts";
import { loadDemoData, removeDemoData } from "@/lib/demo";
import { ensureDrafts } from "@/lib/draft";
import { enrichAndSave, enrichPending } from "@/lib/enrich";
import { ingestNote } from "@/lib/extract";
import { findIntroductions } from "@/lib/match";
import { must, serviceCtx, serviceDb, type Ctx } from "@/lib/supabase";
import type { Opportunity } from "@/lib/types";
import { syncContactDocuments } from "@/lib/vectors";

// Every action resolves the signed-in user first (requireCtx redirects to /login otherwise),
// and all reads/writes go through their RLS-scoped client. Background work after the
// response uses the service client with an explicit owner id.

const evalDateFrom = (formData: FormData) => String(formData.get("eval_date") || defaultEvalDate());

async function updateOpportunity(id: string, patch: Partial<Opportunity>) {
  const ctx = await requireCtx();
  must(
    await ctx.db
      .from("opportunities")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("owner_id", ctx.ownerId)
      .eq("id", id),
  );
}

// ---------- Auth ----------

/** Email/invite are echoed back so the form keeps them after an error (React resets forms on submit). */
export type AuthState = { error: string | null; email?: string; invite?: string };

export async function signUpAction(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const invite = String(formData.get("invite_code") ?? "").trim();

  const fail = (error: string): AuthState => ({ error, email, invite });

  const expected = process.env.INVITE_CODE;
  if (!expected) return fail("Sign-up is closed (no INVITE_CODE configured)");
  if (invite !== expected) return fail("That invite code isn't valid");
  if (!email.includes("@")) return fail("Enter a valid email");
  if (password.length < 8) return fail("Password must be at least 8 characters");

  // Public sign-up is disabled in Supabase; accounts are only created here, after the invite check.
  const { error } = await serviceDb().auth.admin.createUser({ email, password, email_confirm: true });
  if (error) {
    return fail(/already|registered|exists/i.test(error.message) ? "An account with that email already exists" : error.message);
  }
  const signIn = await (await userDb()).auth.signInWithPassword({ email, password });
  if (signIn.error) return fail(signIn.error.message);
  redirect("/onboarding");
}

export async function signInAction(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const { error } = await (await userDb()).auth.signInWithPassword({
    email,
    password: String(formData.get("password") ?? ""),
  });
  if (error) return { error: "Wrong email or password", email };
  redirect("/");
}

export async function signOutAction() {
  await (await userDb()).auth.signOut();
  redirect("/login");
}

// ---------- Demo data ----------

export async function loadDemoAction() {
  await loadDemoData(await requireCtx());
  revalidatePath("/", "layout");
}

export async function removeDemoAction() {
  await removeDemoData(await requireCtx());
  revalidatePath("/", "layout");
}

// ---------- Contacts & notes ----------

/**
 * Re-embeds changed contact documents after the response (vectors.ts). Uses the user's own client:
 * the embed function requires their session. Failures only delay retrieval and fit, so they're logged.
 */
const syncDocuments = (ctx: Ctx) =>
  syncContactDocuments(ctx).catch((e) => console.error("Contact document sync failed:", e));

export async function addNoteAction(formData: FormData) {
  const ctx = await requireCtx();
  const contactId = String(formData.get("contact_id"));
  const date = String(formData.get("date") || defaultEvalDate());
  const notes = String(formData.get("notes") ?? "").trim();
  if (!notes) throw new Error("Note is empty");
  await ingestNote(ctx, contactId, date, notes);
  after(() => syncDocuments(ctx));
  revalidatePath(`/contacts/${contactId}`);
}

export async function importCsvAction(formData: FormData) {
  const ctx = await requireCtx();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) throw new Error("Choose a CSV file");
  await importContactsCsv(ctx, await file.text());
  // Enrich new contacts from the web in the background, after the response is sent.
  const bg = serviceCtx(ctx.ownerId);
  after(() => enrichPending(bg).finally(() => syncDocuments(ctx)));
  revalidatePath("/contacts");
}

export type CreateContactState = { error: string | null };

/** Manual contact entry (modal). Optionally logs a first conversation, then enriches in the background. */
export async function createContactAction(_prev: CreateContactState, formData: FormData): Promise<CreateContactState> {
  const ctx = await requireCtx();
  const text = (key: string) => String(formData.get(key) ?? "").trim() || null;
  const name = text("name");
  if (!name) return { error: "Name is required" };
  if (formData.get("consent") !== "on") return { error: "Confirm this person is OK being added" };

  const strength = Number(formData.get("relationship_strength"));
  const { data, error } = await ctx.db
    .from("contacts")
    .insert({
      owner_id: ctx.ownerId,
      name,
      company: text("company"),
      title: text("title"),
      industry: text("industry"),
      relationship_strength: strength >= 1 && strength <= 5 ? strength : 3,
      last_interaction_date: text("last_interaction_date"),
      introduction_preferences: text("introduction_preferences"),
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) return { error: error?.message ?? "Couldn't save the contact" };
  const id = data.id;

  const notes = text("notes");
  if (notes) {
    try {
      await ingestNote(ctx, id, text("last_interaction_date") ?? defaultEvalDate(), notes);
    } catch (e) {
      return { error: `Contact saved, but note extraction failed: ${(e as Error).message}` };
    }
  }
  const bg = serviceCtx(ctx.ownerId);
  after(() =>
    enrichAndSave(bg, id)
      .catch((e) => console.error(`Enrichment failed for ${id}:`, e))
      .finally(() => syncDocuments(ctx)),
  );
  revalidatePath("/contacts");
  redirect(`/contacts/${id}`);
}

export async function enrichContactAction(formData: FormData) {
  const ctx = await requireCtx();
  const id = String(formData.get("contact_id"));
  await enrichAndSave(ctx, id);
  revalidatePath(`/contacts/${id}`);
}

export async function enrichAllAction() {
  await enrichPending(await requireCtx());
  revalidatePath("/contacts");
}

// ---------- Briefing ----------

export async function findIntroductionsAction(formData: FormData) {
  const ctx = await requireCtx();
  await findIntroductions(ctx);
  await ensureDrafts(ctx, evalDateFrom(formData));
  revalidatePath("/");
}

/** Moves a recommendation through the double opt-in: ask recipient -> ask proposed -> intro. */
export async function advanceAction(formData: FormData) {
  const id = String(formData.get("id"));
  switch (String(formData.get("step"))) {
    case "recipient_yes":
      await updateOpportunity(id, { consent_status: "pending", status: "useful" });
      break;
    case "proposed_yes":
      await updateOpportunity(id, { consent_status: "approved", status: "useful" });
      break;
    case "declined":
      await updateOpportunity(id, { consent_status: "declined" });
      break;
    case "intro_sent":
      await updateOpportunity(id, { status: "completed" });
      break;
  }
  revalidatePath("/");
}

export async function setStatusAction(formData: FormData) {
  const status = String(formData.get("status")) as Opportunity["status"];
  const deferred_until =
    status === "deferred"
      ? new Date(Date.parse(evalDateFrom(formData)) + 7 * 86_400_000).toISOString().slice(0, 10)
      : null;
  await updateOpportunity(String(formData.get("id")), { status, deferred_until });
  revalidatePath("/");
}

export async function redraftAction(formData: FormData) {
  await updateOpportunity(String(formData.get("id")), { draft_message: null, draft_kind: null });
  revalidatePath("/");
}

// ---------- Today: reconnect (people whose top reason isn't an intro) ----------

export async function reconnectDecisionAction(formData: FormData) {
  const ctx = await requireCtx();
  const decision = String(formData.get("decision")) === "snooze" ? "snooze" : "sent";
  await recordDecision(ctx, String(formData.get("contact_id")), decision, evalDateFrom(formData));
  revalidatePath("/");
}

export async function reconnectRedraftAction(formData: FormData) {
  const ctx = await requireCtx();
  await getOrCreateCatchUpDraft(ctx, String(formData.get("contact_id")), evalDateFrom(formData), true);
  revalidatePath("/");
}

export async function setEvalDateAction(formData: FormData) {
  redirect(`/?date=${String(formData.get("date"))}`);
}

// ---------- Catch-up deck ----------
// Called directly from the swipe deck (not forms). They return results instead of throwing, and skip
// revalidation so a swipe doesn't re-render the deck; other pages are dynamic and refetch on navigation.

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function catchUpDraftAction(contactId: string, evalDate: string, fresh = false): Promise<Result<string>> {
  if (typeof contactId !== "string" || !isDate(evalDate)) return { ok: false, error: "Invalid request" };
  const ctx = await requireCtx(); // outside try: its redirect to /login must propagate
  try {
    return { ok: true, value: await getOrCreateCatchUpDraft(ctx, contactId, evalDate, fresh === true, "keep_warm") };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function catchUpDecisionAction(
  contactId: string,
  decision: CatchUpDecision,
  evalDate: string,
): Promise<Result<null>> {
  if (typeof contactId !== "string" || !isDate(evalDate) || (decision !== "sent" && decision !== "snooze")) {
    return { ok: false, error: "Invalid request" };
  }
  const ctx = await requireCtx();
  try {
    await recordDecision(ctx, contactId, decision, evalDate);
    return { ok: true, value: null };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
