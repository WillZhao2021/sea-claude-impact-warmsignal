import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { defaultEvalDate } from "../briefing";
import { getOrCreateCatchUpDraft } from "../catch-up";
import { buildMoves, type Move } from "../moves";
import { enrichAndSave } from "../enrich";
import { ingestNote } from "../extract";
import { normalizePhone } from "../phonebook";
import { getProfile, GOALS, INDUSTRIES, OFFERS, ROLES, saveProfile, type Profile } from "../profile";
import { must, type Ctx } from "../supabase";
import { buildToday } from "../today";
import type { Contact, Signal } from "../types";
import type { ChatCard, PersonCard } from "./cards";

// Tools the chat assistant (Haiku) can call. Each returns `text` for Claude and optional `cards`
// for the UI. Phone numbers and emails go only into cards, never into `text`
// (docs/data-contract.md: they are never sent to Claude).

export type ToolOutput = { text: string; cards?: ChatCard[]; isError?: boolean; contactsChanged?: boolean };

const ids = <T extends readonly (readonly [string, string])[]>(xs: T) => xs.map(([id]) => id);
const OFFER_IDS = ids(OFFERS);
const ROLE_IDS = ids(ROLES);
const GOAL_IDS = GOALS.map((g) => g.id);

const str = (d: string) => ({ type: "string", description: d });

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "save_profile",
    description:
      "Save the user's onboarding answers. Only include fields the user explicitly told you in this conversation: never guess or fill in defaults. If what they offer doesn't fit the offers list, leave offers out and put their words in offer_line.",
    input_schema: {
      type: "object",
      properties: {
        full_name: str("The user's name, used to sign drafted messages"),
        offers: { type: "array", items: { type: "string", enum: OFFER_IDS }, description: "What the user offers" },
        offer_line: str("One sentence, in the user's words, describing what they do"),
        goal: { type: "string", enum: GOAL_IDS, description: "The user's main goal" },
        industries: { type: "array", items: { type: "string", enum: [...INDUSTRIES] }, description: "Ideal-client industries" },
        roles: { type: "array", items: { type: "string", enum: ROLE_IDS }, description: "Ideal-client roles" },
        per_day: { type: "integer", minimum: 1, maximum: 10, description: "People to suggest per day" },
        tone: { type: "string", enum: ["warm", "professional", "brief"], description: "Tone for drafted messages" },
      },
    },
  },
  {
    name: "finish_onboarding",
    description: "Mark onboarding complete. Call once, after the profile is saved and the user has uploaded (or skipped) their contacts.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "request_upload",
    description:
      "Show an upload card in the chat. linkedin = LinkedIn's Connections.csv (or any contacts CSV); phone = an address book (vCard .vcf or Google Contacts CSV) to add phone numbers for WhatsApp. The upload result arrives as the user's next message.",
    input_schema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["linkedin", "phone"] } },
      required: ["kind"],
    },
  },
  {
    name: "ask_choices",
    description:
      "Show tap-to-answer buttons under your question (e.g. the goal options, yes/no, which contacts). Use it whenever the user picks from a short list. Their tap arrives as their next message.",
    input_schema: {
      type: "object",
      properties: {
        options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 8, description: "Short labels, max ~6 words each" },
        multi: { type: "boolean", description: "true if they can pick several (they'll get a Done button)" },
      },
      required: ["options"],
    },
  },
  {
    name: "review_network",
    description:
      "Find what's missing in the user's network data: contacts with no notes, never looked up on the web, no phone number, or an unconfirmed relationship strength. Warmest contacts first. Use it to decide what to ask the user or which contacts to enrich.",
    input_schema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 10 } } },
  },
  {
    name: "enrich_contacts",
    description:
      "Search the public web (Tavily) for up to 5 contacts at once and update their profiles. Takes 20-60 seconds. Use contact ids from review_network, search_contacts or show_today.",
    input_schema: {
      type: "object",
      properties: { contact_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 } },
      required: ["contact_ids"],
    },
  },
  {
    name: "show_today",
    description: "The people worth talking to today and why, ranked. Shows them as cards.",
    input_schema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 10 } } },
  },
  {
    name: "search_contacts",
    description: "Find contacts by name, company or title. Use it to get a contact_id before other contact tools.",
    input_schema: { type: "object", properties: { query: str("Name, company or title") }, required: ["query"] },
  },
  {
    name: "get_contact",
    description: "Everything known about one contact: role, relationship, needs, offers and public-web summary.",
    input_schema: { type: "object", properties: { contact_id: str("From search_contacts or show_today") }, required: ["contact_id"] },
  },
  {
    name: "add_contact",
    description: "Add a new person to the network. They are enriched from the public web in the background.",
    input_schema: {
      type: "object",
      properties: {
        name: str("Full name"),
        company: str("Company"),
        title: str("Job title"),
        relationship_strength: { type: "integer", minimum: 1, maximum: 5, description: "1 = barely know, 5 = close" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_contact",
    description: "Correct or fill in a contact's details from what the user tells you.",
    input_schema: {
      type: "object",
      properties: {
        contact_id: str("Contact id"),
        company: str("Company"),
        title: str("Job title"),
        industry: str("Industry"),
        relationship_strength: { type: "integer", minimum: 1, maximum: 5 },
        last_interaction_date: str("YYYY-MM-DD of their last real conversation"),
        introduction_preferences: str("Preferences or sensitivities about introductions"),
        phone: str("Phone number the user gave you"),
        email: str("Email address the user gave you"),
      },
      required: ["contact_id"],
    },
  },
  {
    name: "add_note",
    description:
      "Save what the user tells you about a conversation with a contact. Claude extracts their needs and offers from it, which drive introductions.",
    input_schema: {
      type: "object",
      properties: {
        contact_id: str("Contact id"),
        note: str("The user's account of the conversation, in their words (keep quotes verbatim)"),
        date: str("YYYY-MM-DD the conversation happened; omit for today"),
      },
      required: ["contact_id", "note"],
    },
  },
  {
    name: "enrich_contact",
    description: "Search the public web (Tavily) for a contact and update their profile. Takes 10-30 seconds.",
    input_schema: { type: "object", properties: { contact_id: str("Contact id") }, required: ["contact_id"] },
  },
  {
    name: "draft_message",
    description: "Draft a short message to a contact in the user's tone, with a WhatsApp button. Nothing is sent.",
    input_schema: { type: "object", properties: { contact_id: str("Contact id") }, required: ["contact_id"] },
  },
];

/** Human label shown while a tool runs. */
export const TOOL_LABELS: Record<string, string> = {
  save_profile: "Saving your profile",
  finish_onboarding: "Finishing setup",
  request_upload: "Preparing upload",
  ask_choices: "Preparing options",
  review_network: "Checking what's missing",
  enrich_contacts: "Searching the web",
  show_today: "Ranking today's people",
  search_contacts: "Searching your contacts",
  get_contact: "Looking them up",
  add_contact: "Adding contact",
  update_contact: "Updating contact",
  add_note: "Reading your note",
  enrich_contact: "Searching the web",
  draft_message: "Drafting a message",
};

// ---------- helpers ----------

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const role = (c: Pick<Contact, "title" | "company">) => [c.title, c.company].filter(Boolean).join(" at ") || null;

function person(c: Contact, reasons: string[] = [], move?: Move): PersonCard {
  return {
    id: c.id,
    name: c.name,
    role: role(c),
    strength: c.relationship_strength,
    lastSpoke: c.last_interaction_date,
    reasons,
    phone: c.phone ?? null,
    move,
  };
}

/** Adds the Give / Ask move to every person card that lacks one, and tells Claude what it is. */
async function withMoves(ctx: Ctx, out: ToolOutput): Promise<ToolOutput> {
  const people = (out.cards ?? []).flatMap((card) =>
    card.type === "people" ? card.people : card.type === "contact" ? [card.person] : [],
  );
  if (!people.length) return out;
  if (people.some((p) => !p.move)) {
    const { moves } = await buildMoves(ctx, defaultEvalDate());
    for (const p of people) p.move ??= moves.get(p.id);
  }
  const lines = people.filter((p) => p.move).map((p) => `${p.name}: ${p.move!.kind} (${p.move!.why})`);
  return lines.length ? { ...out, text: `${out.text}\nNext move (give or ask): ${lines.join("; ")}` } : out;
}

/** One line per contact for Claude: never includes phone or email. */
function line(c: Contact, extra?: string) {
  return `${c.id}: ${c.name}${role(c) ? `, ${role(c)}` : ""} (relationship ${c.relationship_strength}/5, last spoke ${c.last_interaction_date ?? "unknown"})${extra ? ` - ${extra}` : ""}`;
}

async function loadContact(ctx: Ctx, id: string): Promise<Contact | null> {
  const { data } = await ctx.db.from("contacts").select("*").eq("owner_id", ctx.ownerId).eq("id", id).maybeSingle<Contact>();
  return data;
}

const notFound = (id: string): ToolOutput => ({ text: `No contact with id ${id}. Use search_contacts first.`, isError: true });

function profileLines(p: Profile | null): [string, string][] {
  if (!p) return [];
  const label = (list: readonly (readonly [string, string])[], id: string) => list.find(([k]) => k === id)?.[1] ?? id;
  const rows: [string, string][] = [];
  if (p.full_name) rows.push(["Name", p.full_name]);
  if (p.offer_line) rows.push(["What you do", p.offer_line]);
  if (p.offers.length) rows.push(["Offers", p.offers.map((o) => label(OFFERS, o)).join(", ")]);
  if (p.goal) rows.push(["Goal", GOALS.find((g) => g.id === p.goal)?.name ?? p.goal]);
  if (p.industries.length) rows.push(["Ideal-client industries", p.industries.join(", ")]);
  if (p.roles.length) rows.push(["Ideal-client roles", p.roles.map((r) => label(ROLES, r)).join(", ")]);
  rows.push(["People per day", String(p.per_day)], ["Tone", p.tone]);
  return rows;
}

// ---------- input schemas (validated before running; the model's input is untrusted) ----------

const Id = z.object({ contact_id: z.string().min(1) });
const Inputs = {
  save_profile: z.object({
    full_name: z.string().max(120).optional(),
    offers: z.array(z.enum(OFFER_IDS as [string, ...string[]])).optional(),
    offer_line: z.string().max(300).optional(),
    goal: z.enum(GOAL_IDS as [string, ...string[]]).optional(),
    industries: z.array(z.enum(INDUSTRIES)).optional(),
    roles: z.array(z.enum(ROLE_IDS as [string, ...string[]])).optional(),
    per_day: z.number().int().min(1).max(10).optional(),
    tone: z.enum(["warm", "professional", "brief"]).optional(),
  }),
  finish_onboarding: z.object({}),
  request_upload: z.object({ kind: z.enum(["linkedin", "phone"]) }),
  ask_choices: z.object({ options: z.array(z.string().min(1).max(80)).min(2).max(8), multi: z.boolean().optional() }),
  review_network: z.object({ limit: z.number().int().min(1).max(10).optional() }),
  enrich_contacts: z.object({ contact_ids: z.array(z.string().min(1)).min(1).max(5) }),
  show_today: z.object({ limit: z.number().int().min(1).max(10).optional() }),
  search_contacts: z.object({ query: z.string().min(1).max(100) }),
  get_contact: Id,
  add_contact: z.object({
    name: z.string().min(1).max(120),
    company: z.string().max(120).optional(),
    title: z.string().max(120).optional(),
    relationship_strength: z.number().int().min(1).max(5).optional(),
  }),
  update_contact: Id.extend({
    company: z.string().max(120).optional(),
    title: z.string().max(120).optional(),
    industry: z.string().max(120).optional(),
    relationship_strength: z.number().int().min(1).max(5).optional(),
    last_interaction_date: z.string().regex(ISO).optional(),
    introduction_preferences: z.string().max(500).optional(),
    phone: z.string().max(40).optional(),
    email: z.string().email().max(200).optional(),
  }),
  add_note: Id.extend({ note: z.string().min(1).max(5000), date: z.string().regex(ISO).optional() }),
  enrich_contact: Id,
  draft_message: Id,
} as const;

type ToolName = keyof typeof Inputs;

// ---------- executors ----------

export async function runTool(ctx: Ctx, name: string, input: unknown, signal?: AbortSignal): Promise<ToolOutput> {
  const out = await execute(ctx, name, input, signal);
  return out.isError ? out : withMoves(ctx, out);
}

async function execute(ctx: Ctx, name: string, input: unknown, signal?: AbortSignal): Promise<ToolOutput> {
  if (!(name in Inputs)) return { text: `Unknown tool ${name}`, isError: true };
  const parsed = Inputs[name as ToolName].safeParse(input);
  if (!parsed.success) return { text: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
  const args = parsed.data as Record<string, unknown>;
  const evalDate = defaultEvalDate();

  switch (name as ToolName) {
    case "save_profile": {
      await saveProfile(ctx, args as Partial<Profile>);
      const p = await getProfile(ctx);
      return { text: `Saved. Profile now: ${JSON.stringify(p && { ...p, onboarded_at: undefined })}`, cards: [{ type: "profile", lines: profileLines(p) }] };
    }
    case "finish_onboarding": {
      await saveProfile(ctx, { onboarded_at: new Date().toISOString() });
      return { text: "Onboarding complete.", cards: [{ type: "notice", text: "Setup complete. Today shows who to talk to; Chat helps you fill in your network.", href: "/" }] };
    }
    case "request_upload": {
      const kind = args.kind as "linkedin" | "phone";
      return {
        text: `Upload card shown for ${kind}. Wait for the user's upload; its result arrives as their next message.`,
        cards: [{ type: "upload", kind }],
      };
    }
    case "ask_choices": {
      const options = args.options as string[];
      return {
        text: `Buttons shown: ${options.join(" | ")}. Wait for the user's answer.`,
        cards: [{ type: "choices", options, multi: Boolean(args.multi) }],
      };
    }
    case "review_network": {
      const [contacts, noted] = await Promise.all([
        ctx.db
          .from("contacts")
          .select("*")
          .eq("owner_id", ctx.ownerId)
          .then((r) => must<Contact[]>(r)),
        ctx.db
          .from("interactions")
          .select("contact_id")
          .eq("owner_id", ctx.ownerId)
          .then((r) => new Set(must<{ contact_id: string }[]>(r).map((i) => i.contact_id))),
      ]);
      if (!contacts.length) return { text: "The network is empty. Ask the user to upload their LinkedIn connections (request_upload)." };
      const gapsOf = (c: Contact) =>
        [
          !noted.has(c.id) && "No notes yet",
          !c.enriched_at && "Never looked up on the web",
          !c.phone && "No phone number",
          c.relationship_strength <= 2 && !c.last_interaction_date && "Relationship strength not confirmed",
        ].filter((g): g is string => !!g);
      const withGaps = contacts
        .map((c) => ({ c, gaps: gapsOf(c) }))
        .filter((x) => x.gaps.length)
        .sort((a, b) => b.c.relationship_strength - a.c.relationship_strength || b.gaps.length - a.gaps.length);
      const count = (g: string) => withGaps.filter((x) => x.gaps.includes(g)).length;
      const totals = `${contacts.length} contacts: ${count("No notes yet")} with no notes, ${count("Never looked up on the web")} never looked up on the web, ${count("No phone number")} without a phone number, ${count("Relationship strength not confirmed")} with unconfirmed strength.`;
      const top = withGaps.slice(0, (args.limit as number | undefined) ?? 6);
      if (!top.length) return { text: `${totals} Nothing important is missing.` };
      return {
        text: `${totals}\nWarmest with gaps:\n${top.map((x) => line(x.c, x.gaps.join(", "))).join("\n")}`,
        cards: [{ type: "people", title: "Missing information", people: top.map((x) => person(x.c, x.gaps)) }],
      };
    }
    case "enrich_contacts": {
      const ids = [...new Set(args.contact_ids as string[])];
      const results: { c: Contact; summary: string | null; note: string }[] = [];
      for (let i = 0; i < ids.length; i += 3) {
        await Promise.all(
          ids.slice(i, i + 3).map(async (id) => {
            const c = await loadContact(ctx, id);
            if (!c) return;
            try {
              const e = await enrichAndSave(ctx, id, { signal });
              const fresh = (await loadContact(ctx, id)) ?? c;
              results.push(
                e.status === "matched"
                  ? { c: fresh, summary: e.summary, note: [e.summary, ...e.recent_signals.slice(0, 2).map((s) => s.text)].join(" Recent: ") }
                  : { c: fresh, summary: null, note: `No confident match (${e.identity_notes})` },
              );
            } catch (err) {
              results.push({ c, summary: null, note: `Search failed: ${err instanceof Error ? err.message : "unknown error"}` });
            }
          }),
        );
      }
      if (!results.length) return { text: "None of those contact ids exist. Use review_network or search_contacts.", isError: true };
      return {
        text: results.map((r) => `${r.c.id}: ${r.c.name} - ${r.note}`).join("\n"),
        cards: [
          {
            type: "people",
            title: "Looked up on the web",
            people: results.map((r) => person(r.c, [r.summary ?? r.note])),
          },
        ],
        contactsChanged: true,
      };
    }
    case "show_today": {
      const today = await buildToday(ctx, evalDate);
      const people = today.people.slice(0, (args.limit as number | undefined) ?? today.people.length);
      if (!people.length) return { text: "Nobody is due today (no contacts, or everyone was contacted recently)." };
      return {
        text: people.map((p) => line(p.contact, p.reasons.map((r) => r.title).join("; "))).join("\n"),
        cards: [{ type: "people", title: "Talk with today", people: people.map((p) => person(p.contact, p.reasons.map((r) => r.title), p.move)) }],
      };
    }
    case "search_contacts": {
      // Escape PostgREST's or() syntax characters so the query can't alter the filter.
      const q = String(args.query).replace(/[%,()*\\]/g, " ").trim();
      const found = must<Contact[]>(
        await ctx.db
          .from("contacts")
          .select("*")
          .eq("owner_id", ctx.ownerId)
          .or(`name.ilike.%${q}%,company.ilike.%${q}%,title.ilike.%${q}%`)
          .order("relationship_strength", { ascending: false })
          .limit(8),
      );
      if (!found.length) return { text: `No contacts match "${q}".` };
      return { text: found.map((c) => line(c)).join("\n"), cards: [{ type: "people", title: `Matches for "${q}"`, people: found.map((c) => person(c)) }] };
    }
    case "get_contact": {
      const c = await loadContact(ctx, args.contact_id as string);
      if (!c) return notFound(args.contact_id as string);
      const signals = must<Signal[]>(
        await ctx.db.from("signals").select("*").eq("owner_id", ctx.ownerId).eq("contact_id", c.id).eq("status", "active"),
      );
      const needs = signals.filter((s) => s.type === "need").map((s) => s.description);
      const offers = signals.filter((s) => s.type === "offer").map((s) => s.description);
      const e = c.enrichment;
      const summary = e?.status === "matched" ? e.summary : null;
      const web = e?.status === "matched" ? [summary, ...e.recent_signals.map((s) => `${s.date ?? "recent"}: ${s.text}`)].filter(Boolean).join(" | ") : "none";
      return {
        text: [
          line(c),
          `Industry: ${c.industry ?? "?"}. Intro preferences: ${c.introduction_preferences ?? "none"}. Has phone: ${c.phone ? "yes" : "no"}.`,
          `Needs: ${needs.join("; ") || "none recorded"}`,
          `Offers: ${offers.join("; ") || "none recorded"}`,
          `Public web (unverified): ${web}`,
        ].join("\n"),
        cards: [{ type: "contact", person: person(c), summary, needs, offers, enrichedAt: c.enriched_at }],
      };
    }
    case "add_contact": {
      const { data, error } = await ctx.db
        .from("contacts")
        .insert({
          owner_id: ctx.ownerId,
          name: args.name,
          company: (args.company as string) ?? null,
          title: (args.title as string) ?? null,
          relationship_strength: (args.relationship_strength as number) ?? 3,
        })
        .select("*")
        .single<Contact>();
      if (error || !data) return { text: `Couldn't add: ${error?.message}`, isError: true };
      // Enrichment can take 30s; the chat runs it now so the card has the web profile.
      const c = (await enrichAndSave(ctx, data.id, { signal }).then(() => loadContact(ctx, data.id)).catch(() => data)) ?? data;
      const summary = c.enrichment?.status === "matched" ? c.enrichment.summary : null;
      return {
        text: `Added ${line(c)}. Public web: ${summary ?? "no confident match"}`,
        cards: [{ type: "contact", person: person(c), summary, needs: [], offers: [], enrichedAt: c.enriched_at }],
        contactsChanged: true,
      };
    }
    case "update_contact": {
      const { contact_id, phone, ...rest } = args as { contact_id: string; phone?: string } & Record<string, unknown>;
      const c = await loadContact(ctx, contact_id);
      if (!c) return notFound(contact_id);
      const patch: Record<string, unknown> = { ...rest };
      if (phone !== undefined) {
        const p = normalizePhone(phone);
        if (!p) return { text: "That phone number doesn't look valid; ask for it with the country code.", isError: true };
        patch.phone = p;
      }
      must(await ctx.db.from("contacts").update(patch).eq("owner_id", ctx.ownerId).eq("id", contact_id));
      const updated = (await loadContact(ctx, contact_id))!;
      const changed = Object.keys(patch).map((k) => (k === "phone" || k === "email" ? `${k} (saved)` : k));
      return { text: `Updated ${changed.join(", ")} for ${updated.name}.`, cards: [{ type: "contact", person: person(updated), summary: null, needs: [], offers: [], enrichedAt: updated.enriched_at }], contactsChanged: true };
    }
    case "add_note": {
      const c = await loadContact(ctx, args.contact_id as string);
      if (!c) return notFound(args.contact_id as string);
      const interactionId = await ingestNote(ctx, c.id, (args.date as string) ?? evalDate, args.note as string);
      const signals = must<Signal[]>(
        await ctx.db.from("signals").select("*").eq("owner_id", ctx.ownerId).eq("interaction_id", interactionId),
      );
      const needs = signals.filter((s) => s.type === "need").map((s) => s.description);
      const offers = signals.filter((s) => s.type === "offer").map((s) => s.description);
      return {
        text: `Saved the note for ${c.name}. Needs found: ${needs.join("; ") || "none"}. Offers found: ${offers.join("; ") || "none"}.`,
        cards: [{ type: "note", contactId: c.id, name: c.name, needs, offers }],
        contactsChanged: true,
      };
    }
    case "enrich_contact": {
      const c = await loadContact(ctx, args.contact_id as string);
      if (!c) return notFound(args.contact_id as string);
      const e = await enrichAndSave(ctx, c.id, { signal });
      const fresh = (await loadContact(ctx, c.id))!;
      const summary = e.status === "matched" ? e.summary : null;
      const news = e.status === "matched" ? e.recent_signals.map((s) => s.text).join("; ") : "";
      return {
        text: e.status === "matched" ? `Web profile for ${c.name}: ${summary}${news ? ` Recent: ${news}` : ""}` : `No confident web match for ${c.name}: ${e.identity_notes}`,
        cards: [{ type: "contact", person: person(fresh), summary, needs: [], offers: [], enrichedAt: fresh.enriched_at }],
        contactsChanged: true,
      };
    }
    case "draft_message": {
      const c = await loadContact(ctx, args.contact_id as string);
      if (!c) return notFound(args.contact_id as string);
      const text = await getOrCreateCatchUpDraft(ctx, c.id, evalDate, false, "reconnect");
      return { text: `Draft for ${c.name}:\n${text}`, cards: [{ type: "draft", contactId: c.id, name: c.name, phone: c.phone ?? null, text }] };
    }
  }
}
