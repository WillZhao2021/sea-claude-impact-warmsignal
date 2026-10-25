import { after, type NextRequest } from "next/server";
import { userDb } from "@/lib/auth";
import { OPEN_MARKER, runChatTurn, shouldOpen, type ChatMode } from "@/lib/chat/agent";
import type { ChatFrame } from "@/lib/chat/cards";
import { syncContactDocuments } from "@/lib/vectors";

// One chat turn, streamed as Server-Sent Events: text deltas, "running tool" labels, cards, done.
// POST: it writes to the database, and EventSource's auto-reconnect would re-run it.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_MESSAGE = 8000;

export async function POST(request: NextRequest) {
  // Not requireCtx(): its redirect would hand the client an HTML page instead of a stream.
  const db = await userDb();
  const { data } = await db.auth.getClaims();
  const ownerId = data?.claims?.sub;
  if (!ownerId) return Response.json({ error: "Not signed in" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const mode: ChatMode = body?.mode === "onboarding" ? "onboarding" : "main";
  // `open`: the page just loaded. The assistant starts a round itself if the thread is new or idle.
  const open = body?.open === true;
  const message = open ? OPEN_MARKER : typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return Response.json({ error: "Empty message" }, { status: 400 });
  if (message.length > MAX_MESSAGE) return Response.json({ error: "Message is too long" }, { status: 400 });
  if (open && !(await shouldOpen({ db, ownerId }, mode))) return Response.json({ opened: false });

  const encoder = new TextEncoder();
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort());
  const ctx = { db, ownerId };

  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const write = (chunk: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          open = false;
        }
      };
      const send = (frame: ChatFrame) => write(`data: ${JSON.stringify(frame)}\n\n`);
      // Padding flushes intermediary buffers; keep-alives stop idle proxies closing long tool runs.
      write(`: ${" ".repeat(2048)}\n\n`);
      const keepAlive = setInterval(() => write(": keep-alive\n\n"), 15000);
      try {
        await runChatTurn(ctx, mode, message, send, abort.signal);
        // Notes, new contacts and enrichment change search documents; re-embed after the response.
        after(() => syncContactDocuments(ctx).catch((e) => console.error("Contact document sync failed:", e)));
      } catch (e) {
        if (!abort.signal.aborted) {
          console.error("Chat turn failed:", e);
          send({ type: "error", message: e instanceof Error ? e.message : "Something went wrong" });
        }
      } finally {
        clearInterval(keepAlive);
        if (open) controller.close();
        open = false;
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
