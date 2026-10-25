import { after, type NextRequest } from "next/server";
import { userDb } from "@/lib/auth";
import { enrichAndSave, type EnrichEvent } from "@/lib/enrich";
import { mapNetworkAndSave, type NetworkEvent } from "@/lib/network";
import { syncContactDocuments } from "@/lib/vectors";

// Streams enrichment progress as Server-Sent Events: searches, sources as each search returns,
// Claude's partial output while it writes, the identity-gated result once saved, then how the
// contact maps onto the rest of the network (overlaps, introductions, ideas).
// POST rather than GET: it writes to the database, and EventSource's auto-reconnect would re-run it.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Frame = EnrichEvent | NetworkEvent | { type: "saved"; intros_saved: number; intros_added: number } | { type: "error"; message: string };

export async function POST(request: NextRequest, ctx: RouteContext<"/api/contacts/[id]/enrich">) {
  const { id } = await ctx.params;
  // Not requireCtx(): its redirect would hand the client an HTML page instead of a stream.
  const db = await userDb();
  const { data } = await db.auth.getClaims();
  const ownerId = data?.claims?.sub;
  if (!ownerId) return Response.json({ error: "Not signed in" }, { status: 401 });

  const { count } = await db
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", ownerId)
    .eq("id", id);
  if (!count) return Response.json({ error: "Contact not found" }, { status: 404 });

  const encoder = new TextEncoder();
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort());

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
      const send = (frame: Frame) => write(`data: ${JSON.stringify(frame)}\n\n`);
      // Padding comment flushes intermediary buffers; keep-alives stop idle proxies closing the stream.
      write(`: ${" ".repeat(2048)}\n\n`);
      const keepAlive = setInterval(() => write(": keep-alive\n\n"), 15000);

      // Claude emits many tiny deltas; forward at most one partial snapshot per ~80ms.
      let pending: Frame | null = null;
      let lastPartial = 0;
      const flushPartial = () => {
        if (pending) send(pending);
        pending = null;
        lastPartial = Date.now();
      };
      const onEvent = (e: Frame) => {
        if (e.type === "partial" || e.type === "network_partial") {
          pending = e;
          if (Date.now() - lastPartial > 80) flushPartial();
          return;
        }
        flushPartial();
        send(e);
      };

      try {
        const user = { db, ownerId };
        const enrichment = await enrichAndSave(user, id, { depth: "deep", signal: abort.signal, onEvent });
        // The new web summary changes this contact's search document; re-embed once the stream ends.
        // Registered before mapping so a mapping failure doesn't leave the document stale.
        after(() => syncContactDocuments(user).catch((e) => console.error("Contact document sync failed:", e)));
        // Mapping runs even without a web match: recorded needs and offers still connect people.
        const { saved, added } = await mapNetworkAndSave(user, id, enrichment, { signal: abort.signal, onEvent });
        send({ type: "saved", intros_saved: saved, intros_added: added });
      } catch (e) {
        if (!abort.signal.aborted) {
          console.error(`Enrichment failed for ${id}:`, e);
          send({ type: "error", message: e instanceof Error ? e.message : "Enrichment failed" });
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
