"use server";

import { after } from "next/server";
import { requireCtx } from "@/lib/auth";
import { ImportError, importContactsCsv, importPhonebook } from "@/lib/contacts";
import { enrichPending } from "@/lib/enrich";
import { parsePhonebook } from "@/lib/phonebook";
import { serviceCtx } from "@/lib/supabase";
import { syncContactDocuments } from "@/lib/vectors";

export type ChatUploadResult = { ok: true; summary: string } | { ok: false; error: string };

/**
 * A file dropped into the chat. Address books (vCard / Google Contacts CSV) only add phone numbers
 * and emails to existing contacts; anything else is a contacts CSV (LinkedIn's Connections export or
 * any CSV), imported as new contacts and enriched in the background. Returns a one-line summary
 * that the chat sends to the assistant as the user's next message.
 */
export async function chatUploadAction(formData: FormData): Promise<ChatUploadResult> {
  const ctx = await requireCtx();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a file first." };
  if (file.size > 20_000_000) return { ok: false, error: "That file is over 20 MB." };
  const text = await file.text();
  try {
    if (parsePhonebook(text)) {
      const r = await importPhonebook(ctx, text);
      const skipped = r.ambiguous.length ? ` Skipped ${r.ambiguous.length} with more than one match (${r.ambiguous.slice(0, 5).join(", ")}).` : "";
      return { ok: true, summary: `[Upload] Address book "${file.name}": added phone numbers or emails to ${r.updated} contacts from ${r.entries} entries.${skipped}` };
    }
    const added = await importContactsCsv(ctx, text);
    const bg = serviceCtx(ctx.ownerId);
    after(() =>
      enrichPending(bg).finally(() => syncContactDocuments(ctx).catch((e) => console.error("Contact document sync failed:", e))),
    );
    return { ok: true, summary: `[Upload] Contacts "${file.name}": ${added} contacts imported. Web enrichment is running in the background.` };
  } catch (e) {
    return { ok: false, error: e instanceof ImportError ? e.message : `Couldn't import that file: ${(e as Error).message}` };
  }
}
