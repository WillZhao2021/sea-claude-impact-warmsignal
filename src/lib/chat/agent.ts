import Anthropic from "@anthropic-ai/sdk";
import { anthropic, FAST_MODEL } from "../claude";
import { getProfile, offerLine } from "../profile";
import { must, type Ctx } from "../supabase";
import type { ChatCard, ChatFrame, ChatRow } from "./cards";
import { runTool, TOOL_LABELS, TOOLS } from "./tools";

// The chat: Haiku with WarmSignal's tools, in a manual streaming tool loop. Every message
// (user text, assistant content, tool results) is stored append-only in chat_messages and replayed
// as history, so onboarding progress and context survive reloads.

export const CHAT_MODEL = process.env.ANTHROPIC_CHAT_MODEL ?? FAST_MODEL;
/** Stored messages replayed as context each turn. */
const HISTORY_LIMIT = 60;
/** Tool round trips per user message before the assistant must answer. */
const MAX_STEPS = 8;

const SYSTEM = `You are WarmSignal, a relationship assistant in a chat. WarmSignal helps the user become a super connector: by giving first (making useful introductions and checking in at the right moments), they earn referrals and new business.

How you work:
- Keep replies short: one to three sentences, then at most one question. Cards in the chat show details (people, profiles, drafts), so don't repeat what a card shows.
- Use tools for every fact about the user's network. Never invent people, needs, or news. Public-web info is unverified; say so if it matters.
- When the user tells you about a conversation with someone, find them (search_contacts), then add_note with their words. When they mention someone new, add_contact.
- Suggest a next step when it helps: who to talk to today (show_today), a draft (draft_message), or enriching a thin profile (enrich_contact).
- Never send anything on the user's behalf. Drafts are for them to send.
- Never ask for passwords, login tokens, or cookies. LinkedIn contacts come from LinkedIn's own export file.
- Phone numbers and emails are stored privately for WhatsApp links. You never see them; don't ask to see them.

Onboarding (only while setup is incomplete; it happens once):
1. Greet them and ask their name and what they do. Save answers with save_profile as you learn them.
2. Ask their main goal (give first, find clients, get referrals, win back past clients, find partners) and who their ideal clients are (industries, roles).
3. Ask them to upload LinkedIn connections: call request_upload with kind "linkedin" and explain where the export is (LinkedIn → Settings → Data privacy → Get a copy of your data → Connections; the file arrives by email in about 10 minutes). They can skip.
4. Then ask for phone contacts so they can message people on WhatsApp: request_upload with kind "phone" (iPhone: iCloud.com → Contacts → Export vCard; Google Contacts → Export → Google CSV). They can skip.
5. Ask which few people they're closest to and raise their relationship_strength with update_contact.
6. Call finish_onboarding, then show_today.
Upload results arrive as the user's message, starting with "[Upload]".`;

function stateLine(state: { onboarded: boolean; profile: string; contacts: number; phones: number; enriched: number }) {
  return `\n\nCurrent state:\n- Setup: ${state.onboarded ? "complete" : "INCOMPLETE: run onboarding"}\n- Profile: ${state.profile}\n- Network: ${state.contacts} contacts, ${state.phones} with phone numbers, ${state.enriched} enriched from the web\n- Today: ${new Date().toISOString().slice(0, 10)}`;
}

async function loadState(ctx: Ctx) {
  const contacts = () => ctx.db.from("contacts").select("id", { count: "exact", head: true }).eq("owner_id", ctx.ownerId);
  const n = (r: { count: number | null }) => r.count ?? 0;
  const [profile, total, phones, enriched] = await Promise.all([
    getProfile(ctx),
    contacts().then(n),
    contacts().not("phone", "is", null).then(n),
    contacts().eq("enrichment->>status", "matched").then(n),
  ]);
  return {
    onboarded: !!profile?.onboarded_at,
    profile: profile ? `${profile.full_name ?? "name unknown"}; ${offerLine(profile)}; goal ${profile.goal ?? "unset"}` : "not started",
    contacts: total,
    phones,
    enriched,
  };
}

type Stored = { id: string; role: "user" | "assistant"; content: Anthropic.MessageParam["content"]; cards: ChatCard[] };

async function history(ctx: Ctx): Promise<Stored[]> {
  const rows = must<Stored[]>(
    await ctx.db
      .from("chat_messages")
      .select("id, role, content, cards")
      .eq("owner_id", ctx.ownerId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT),
  ).reverse();
  // Start at a plain user message, so the replayed history never opens on an orphaned tool result.
  const start = rows.findIndex((r) => r.role === "user" && (typeof r.content === "string" || !r.content.some((b) => b.type === "tool_result")));
  return start < 0 ? [] : rows.slice(start);
}

async function store(ctx: Ctx, role: "user" | "assistant", content: Anthropic.MessageParam["content"], cards: ChatCard[] = []) {
  must(await ctx.db.from("chat_messages").insert({ owner_id: ctx.ownerId, role, content, cards }));
}

/** The conversation as the UI shows it: text bubbles, with tool cards attached to the turn that made them. */
export async function chatRows(ctx: Ctx): Promise<ChatRow[]> {
  const rows: ChatRow[] = [];
  for (const m of await history(ctx)) {
    const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    const text = blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
    const isToolResult = blocks.some((b) => b.type === "tool_result");
    if (isToolResult) {
      // Tool results belong to the assistant's turn in the UI.
      const last = rows.at(-1);
      if (last?.role === "assistant") last.cards.push(...m.cards);
      else rows.push({ id: m.id, role: "assistant", text: "", cards: m.cards });
    } else if (m.role === "assistant" && rows.at(-1)?.role === "assistant") {
      const last = rows.at(-1)!;
      last.text = [last.text, text].filter(Boolean).join("\n\n");
    } else if (text || m.cards.length) {
      rows.push({ id: m.id, role: m.role, text, cards: [...m.cards] });
    }
  }
  return rows;
}

/** Runs one user turn: streams text and cards through `emit`, storing every message as it completes. */
export async function runChatTurn(
  ctx: Ctx,
  userText: string,
  emit: (f: ChatFrame) => void,
  signal?: AbortSignal,
  client: Pick<Anthropic, "messages"> = anthropic(),
) {
  const [past, state] = await Promise.all([history(ctx), loadState(ctx)]);
  await store(ctx, "user", userText);
  const messages: Anthropic.MessageParam[] = [...past.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: userText }];

  for (let step = 0; step < MAX_STEPS; step++) {
    const stream = client.messages.stream(
      { model: CHAT_MODEL, max_tokens: 2048, system: SYSTEM + stateLine(state), tools: TOOLS, messages },
      { signal },
    );
    stream.on("text", (delta) => emit({ type: "text", delta }));
    const message = await stream.finalMessage();
    await store(ctx, "assistant", message.content);
    messages.push({ role: "assistant", content: message.content });

    if (message.stop_reason === "refusal") {
      emit({ type: "text", delta: "\n\nI can't help with that one." });
      break;
    }
    const uses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (message.stop_reason !== "tool_use" || uses.length === 0) break;
    if (message.stop_reason === "tool_use" && step === MAX_STEPS - 1) {
      // Out of steps: answer the pending calls so the stored history stays valid, then stop.
      const results = uses.map((u) => ({ type: "tool_result" as const, tool_use_id: u.id, content: "Step limit reached; not run.", is_error: true }));
      await store(ctx, "user", results);
      emit({ type: "text", delta: "\n\n(That took too many steps; ask me to continue.)" });
      break;
    }

    // Tools run one at a time: several write the same rows, and order matters (search, then update).
    const results: Anthropic.ToolResultBlockParam[] = [];
    const cards: ChatCard[] = [];
    for (const u of uses) {
      emit({ type: "tool", name: u.name, label: TOOL_LABELS[u.name] ?? u.name });
      let out;
      try {
        out = await runTool(ctx, u.name, u.input, signal);
      } catch (e) {
        console.error(`Chat tool ${u.name} failed:`, e);
        out = { text: `Failed: ${e instanceof Error ? e.message : "unknown error"}`, isError: true };
      }
      for (const card of out.cards ?? []) {
        cards.push(card);
        emit({ type: "card", card });
      }
      results.push({ type: "tool_result", tool_use_id: u.id, content: out.text, ...(out.isError && { is_error: true }) });
    }
    await store(ctx, "user", results, cards);
    messages.push({ role: "user", content: results });
  }
  emit({ type: "done" });
}
