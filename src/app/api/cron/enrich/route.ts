import { refreshStaleEnrichment } from "@/lib/enrich";
import { serviceCtx } from "@/lib/supabase";
import { syncContactDocuments } from "@/lib/vectors";

// Daily job (vercel.json) that keeps web enrichment fresh: each run re-enriches contacts whose
// enrichment is older than REFRESH_AFTER_DAYS, so every contact is refreshed about every two weeks.
// New contacts are enriched on creation (src/app/actions.ts); this catches anything that failed then.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  // Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Without the secret configured, refuse.
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await refreshStaleEnrichment();
  // Refreshed web profiles change each contact's search document; re-embed per owner.
  for (const owner of result.owners) {
    await syncContactDocuments(serviceCtx(owner)).catch((e) => console.error(`Document sync failed for ${owner}:`, e));
  }
  return Response.json({ refreshed: result.refreshed, failed: result.failed });
}
