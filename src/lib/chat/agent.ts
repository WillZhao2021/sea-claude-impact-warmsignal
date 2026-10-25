import Anthropic from "@anthropic-ai/sdk";
import { anthropic, FAST_MODEL } from "../claude";
import { getProfile, offerLine } from "../profile";
import { must, type Ctx } from "../supabase";
import type { ChatCard, ChatFrame, ChatRow } from "./cards";
import { runTool, TOOL_LABELS, TOOLS } from "./tools";

// The chat: Haiku with Daily Networker's tools, in a manual streaming tool loop. Two threads:
// - "onboarding" (/onboarding): one-time setup by conversation.
// - "main" (/chat): filling in the network. It opens by asking about people with missing data.
// Every message (user text, assistant content, tool results) is stored append-only in chat_messages
// and replayed as history, so progress and context survive reloads.

export const CHAT_MODEL = process.env.ANTHROPIC_CHAT_MODEL ?? FAST_MODEL;
/** Stored messages replayed as context each turn. */
const HISTORY_LIMIT = 60;
/** Tool round trips per user message before the assistant must answer. */
const MAX_STEPS = 8;
/** Opening the enrichment chat after this long starts a fresh round of questions. */
const REOPEN_AFTER_MS = 6 * 3600_000;
/** Stored user message that opens a round without the user typing; hidden in the UI. */
export const OPEN_MARKER = "[Open]";

export type ChatMode = "onboarding" | "main";

const COMMON = `You are Daily Networker, a relationship assistant in a chat. Daily Networker helps the user become a super connector: by giving first (making useful introductions and checking in at the right moments), they earn referrals and new business.

How you write:
- One to three short sentences, then at most one question. Plain text: no markdown headings, bold, or tables. A short "- " list is fine.
- When the user picks from a short list (goal, yes/no, which people, how well they know someone), call ask_choices so they can tap instead of type. Don't also write the options out in your message.
- Cards show details (people, profiles, drafts), so don't repeat what a card shows.

Rules:
- Use tools for every fact about the user's network. Never invent people, needs, or news. Public-web info is unverified; say so if it matters.
- Only save what the user actually told you. Never guess profile answers or contact details.
- Never send anything on the user's behalf. Drafts are for them to send.
- Never ask for passwords, login tokens, or cookies. LinkedIn contacts come from LinkedIn's own export file.
- Phone numbers and emails are stored privately for WhatsApp links. You never see them; don't ask to see them.
- Upload results arrive as the user's message, starting with "[Upload]". A message of exactly "${OPEN_MARKER}" means the user just opened the chat: start the conversation yourself.`;

const ONBOARDING = `${COMMON}

This is the one-time setup conversation. One step per message:
1. Greet them; ask their name and what they do in a sentence. Save name and offer_line.
2. Ask what they mainly want to do with their network, with ask_choices: "Make intros" (connect people who should meet) or "Ask for meetings and intros" (reach people who can help them). Save goal "give" or "ask".
3. Ask who their ideal clients or most valuable contacts are (industries, roles). Save what fits the lists.
4. Ask for LinkedIn connections: request_upload kind "linkedin". They can skip.
5. Ask for phone contacts so they can message people on WhatsApp: request_upload kind "phone". They can skip.
6. Ask who their 3-5 closest contacts are; find each with search_contacts and set relationship_strength 4-5 with update_contact.
7. Offer to look those people up on the web (enrich_contacts).
8. Call finish_onboarding. Tell them the Chat tab is where they fill in their network over time, and Today shows who to talk to.
Keep it simple: one question per message, and say which step you're on (e.g. "Step 2 of 6"). The page shows a checklist of these steps.
If setup is already complete, they're here to redo it: walk through the same steps, keeping what they don't change.`;

const MAIN = `${COMMON}

This chat is for filling in and using the user's network. Your main job: find people with missing information and ask the user about them, one person and one question at a time.
- When the user opens the chat ("${OPEN_MARKER}"), call review_network, then greet them in one line and ask your first question about the warmest person with gaps. Good questions: how they know the person (ask_choices: "Close friend", "Colleague", "Client", "Met once", "Don't really know them" → set relationship_strength 5/4/4/2/1), when they last talked, what the person is working on or needs right now (save the answer with add_note), or whether to look them up on the web (enrich_contacts).
- After each answer, save it, then move to the next gap. Every few people, offer to look several up on the web at once (enrich_contacts, up to 5).
- When the user tells you about a conversation, find the person (search_contacts) and add_note with their words. When they mention someone new, add_contact.
- If they ask who to talk to or for a message, use show_today or draft_message.
- Uploads: "Add phone numbers" means request_upload kind "phone"; "Upload LinkedIn connections" means request_upload kind "linkedin".
- To change their own profile or goal, point them to the Setup tab (or the Me page). This chat is for their contacts.`;

const SYSTEMS: Record<ChatMode, string> = { onboarding: ONBOARDING, main: MAIN };

/** Tools offered per thread. Onboarding focuses on setup; the main chat can't redo setup. */
const TOOL_NAMES: Record<ChatMode, Set<string>> = {
  onboarding: new Set([
    "save_profile",
    "ask_choices",
    "request_upload",
    "search_contacts",
    "update_contact",
    "enrich_contacts",
    "finish_onboarding",
    "show_today",
  ]),
  // The Chat tab only fills in the network; profile and setup live in the Setup tab.
  main: new Set(TOOLS.map((t) => t.name).filter((n) => n !== "finish_onboarding" && n !== "save_profile")),
};

function stateLine(state: { onboarded: boolean; profile: string; contacts: number; phones: number; enriched: number }) {
  return `\n\nCurrent state:\n- Setup: ${state.onboarded ? "complete" : "not complete"}\n- Profile: ${state.profile}\n- Network: ${state.contacts} contacts, ${state.phones} with phone numbers, ${state.enriched} enriched from the web\n- Today: ${new Date().toISOString().slice(0, 10)}`;
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

// ---------- storage ----------

type Stored = {
  id: string;
  role: "user" | "assistant";
  content: Anthropic.MessageParam["content"];
  cards: ChatCard[];
  created_at: string;
};

/**
 * The `thread` column comes from a later migration than chat_messages. Until it's applied there is
 * one shared thread: queries drop the filter instead of failing.
 */
let threadsAvailable = true;
const missingThreadColumn = (e: { message: string } | null) => !!e && /thread/.test(e.message);

async function history(ctx: Ctx, mode: ChatMode): Promise<Stored[]> {
  const query = (withThread: boolean) => {
    let q = ctx.db.from("chat_messages").select("id, role, content, cards, created_at").eq("owner_id", ctx.ownerId);
    if (withThread) q = q.eq("thread", mode);
    return q.order("created_at", { ascending: false }).limit(HISTORY_LIMIT);
  };
  let res = await query(threadsAvailable);
  if (threadsAvailable && missingThreadColumn(res.error)) {
    threadsAvailable = false;
    res = await query(false);
  }
  const rows = must<Stored[]>(res).reverse();
  // Start at a plain user message, so the replayed history never opens on an orphaned tool result.
  const start = rows.findIndex((r) => r.role === "user" && (typeof r.content === "string" || !r.content.some((b) => b.type === "tool_result")));
  return start < 0 ? [] : rows.slice(start);
}

async function store(ctx: Ctx, mode: ChatMode, role: "user" | "assistant", content: Anthropic.MessageParam["content"], cards: ChatCard[] = []) {
  const row: Record<string, unknown> = { owner_id: ctx.ownerId, role, content, cards };
  let res = await ctx.db.from("chat_messages").insert(threadsAvailable ? { ...row, thread: mode } : row);
  if (threadsAvailable && missingThreadColumn(res.error)) {
    threadsAvailable = false;
    res = await ctx.db.from("chat_messages").insert(row);
  }
  must(res);
}

// ---------- UI rows ----------

/** The conversation as the UI shows it: text bubbles, with tool cards attached to the turn that made them. */
export async function chatRows(ctx: Ctx, mode: ChatMode): Promise<ChatRow[]> {
  const rows: ChatRow[] = [];
  for (const m of await history(ctx, mode)) {
    const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    const text = blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
    if (m.role === "user" && text === OPEN_MARKER) continue;
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

/** Whether opening the chat should start a new round: nothing yet, or the last message is old. */
export async function shouldOpen(ctx: Ctx, mode: ChatMode): Promise<boolean> {
  const past = await history(ctx, mode);
  const last = past.at(-1);
  return !last || Date.now() - Date.parse(last.created_at) > REOPEN_AFTER_MS;
}

// ---------- history repair ----------

type Block = Exclude<Anthropic.MessageParam["content"], string>[number];
const interrupted = (id: string): Block => ({
  type: "tool_result",
  tool_use_id: id,
  content: "Interrupted before it finished.",
  is_error: true,
});

/**
 * Makes stored history valid to replay. A turn cut off midway (the user left during a web lookup,
 * or the platform stopped the function) can leave a tool call without its result, a result without
 * its call, or two messages from the same side in a row. The API rejects all of these, which would
 * break the chat on every later turn, so they are repaired here (in memory; storage is append-only).
 */
export function repairHistory(input: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const out: { role: "user" | "assistant"; content: Block[] }[] = [];
  let pending: string[] = []; // tool_use ids from the last assistant message, awaiting results
  for (const m of input) {
    if (m.role !== "user" && m.role !== "assistant") continue; // the chat never stores system messages
    let content = (typeof m.content === "string" ? [{ type: "text", text: m.content } as Block] : m.content).filter(
      (b) => !(b.type === "text" && !b.text.trim()),
    );
    if (m.role === "user") {
      // Keep only results for the calls just made (results first), and answer any that were lost.
      const results = content.filter((b) => b.type === "tool_result" && pending.includes(b.tool_use_id));
      const answered = new Set(results.map((b) => (b as Anthropic.ToolResultBlockParam).tool_use_id));
      content = [...results, ...pending.filter((id) => !answered.has(id)).map(interrupted), ...content.filter((b) => b.type !== "tool_result")];
      pending = [];
    } else {
      // An assistant message after unanswered calls: answer them first.
      if (pending.length) out.push({ role: "user", content: pending.map(interrupted) });
      pending = content.flatMap((b) => (b.type === "tool_use" ? [b.id] : []));
    }
    if (!content.length) continue;
    const last = out.at(-1);
    if (last?.role === m.role) {
      // Same side twice in a row: merge (tool results stay first in a user message).
      const all = [...last.content, ...content];
      last.content = m.role === "user" ? [...all.filter((b) => b.type === "tool_result"), ...all.filter((b) => b.type !== "tool_result")] : all;
    } else out.push({ role: m.role, content });
  }
  if (pending.length) out.push({ role: "user", content: pending.map(interrupted) });
  while (out[0]?.role === "assistant") out.shift();
  return out;
}

// ---------- the turn ----------

/** Runs one user turn: streams text and cards through `emit`, storing every message as it completes. */
export async function runChatTurn(
  ctx: Ctx,
  mode: ChatMode,
  userText: string,
  emit: (f: ChatFrame) => void,
  signal?: AbortSignal,
  client: Pick<Anthropic, "messages"> = anthropic(),
) {
  const [past, state] = await Promise.all([history(ctx, mode), loadState(ctx)]);
  await store(ctx, mode, "user", userText);
  let messages = repairHistory([...past.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: userText }]);
  const tools = TOOLS.filter((t) => TOOL_NAMES[mode].has(t.name));
  const call = () => {
    const stream = client.messages.stream(
      { model: CHAT_MODEL, max_tokens: 2048, system: SYSTEMS[mode] + stateLine(state), tools, messages },
      { signal },
    );
    stream.on("text", (delta) => emit({ type: "text", delta }));
    return stream.finalMessage();
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    let message: Anthropic.Message;
    try {
      message = await call();
    } catch (e) {
      // Last resort: if the API still rejects the history, answer from a fresh context rather
      // than failing this (and every later) turn.
      if (!(e instanceof Anthropic.BadRequestError) || step > 0) throw e;
      console.error("Chat history rejected; continuing with a fresh context:", e.message);
      messages = [{ role: "user", content: userText }];
      message = await call();
    }
    await store(ctx, mode, "assistant", message.content);
    messages.push({ role: "assistant", content: message.content });

    if (message.stop_reason === "refusal") {
      emit({ type: "text", delta: "\n\nI can't help with that one." });
      break;
    }
    const uses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (message.stop_reason !== "tool_use" || uses.length === 0) break;
    if (step === MAX_STEPS - 1) {
      // Out of steps: answer the pending calls so the stored history stays valid, then stop.
      const results = uses.map((u) => ({ type: "tool_result" as const, tool_use_id: u.id, content: "Step limit reached; not run.", is_error: true }));
      await store(ctx, mode, "user", results);
      emit({ type: "text", delta: "\n\n(That took too many steps; ask me to continue.)" });
      break;
    }

    // Tools run one at a time: several write the same rows, and order matters (search, then update).
    const results: Anthropic.ToolResultBlockParam[] = [];
    const cards: ChatCard[] = [];
    for (const u of uses) {
      emit({ type: "tool", name: u.name, label: TOOL_LABELS[u.name] ?? u.name });
      let out;
      if (!TOOL_NAMES[mode].has(u.name)) out = { text: `${u.name} isn't available in this chat.`, isError: true };
      else {
        try {
          out = await runTool(ctx, u.name, u.input, signal);
        } catch (e) {
          console.error(`Chat tool ${u.name} failed:`, e);
          out = { text: `Failed: ${e instanceof Error ? e.message : "unknown error"}`, isError: true };
        }
      }
      for (const card of out.cards ?? []) {
        cards.push(card);
        emit({ type: "card", card });
      }
      results.push({ type: "tool_result", tool_use_id: u.id, content: out.text, ...(out.isError && { is_error: true }) });
    }
    await store(ctx, mode, "user", results, cards);
    messages.push({ role: "user", content: results });
  }
  emit({ type: "done" });
}
