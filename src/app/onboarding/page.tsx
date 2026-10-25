import { Chat } from "@/components/chat/chat";
import { requireCtx } from "@/lib/auth";
import { chatRows } from "@/lib/chat/agent";
import type { ChatRow } from "@/lib/chat/cards";
import { getProfile } from "@/lib/profile";

export const dynamic = "force-dynamic";
// Uploads (server action) can import and match hundreds of contacts.
export const maxDuration = 300;

/**
 * One-time setup, entirely by conversation: who you are, your goal, LinkedIn and phone contacts,
 * your closest people. (The Me page edits the same answers as a form.)
 */
export default async function OnboardingPage() {
  const ctx = await requireCtx();
  let rows: ChatRow[] = [];
  try {
    rows = await chatRows(ctx, "onboarding");
  } catch (e) {
    console.error("Onboarding chat unavailable:", e);
  }
  const profile = await getProfile(ctx);
  return <Chat mode="onboarding" initial={rows} redo={!!profile?.onboarded_at} />;
}
