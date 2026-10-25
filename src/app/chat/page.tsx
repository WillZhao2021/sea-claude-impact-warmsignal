import Link from "next/link";
import { redirect } from "next/navigation";
import { Chat } from "@/components/chat/chat";
import { btn, card } from "@/components/ui";
import { requireCtx } from "@/lib/auth";
import { chatRows } from "@/lib/chat/agent";
import type { ChatRow } from "@/lib/chat/cards";
import { getProfile } from "@/lib/profile";

export const dynamic = "force-dynamic";
// Uploads (server action) and web lookups can take a while.
export const maxDuration = 300;

/** The main chat: filling in the network. It opens by asking about people with missing information. */
export default async function ChatPage() {
  const ctx = await requireCtx();
  if (!(await getProfile(ctx))?.onboarded_at) redirect("/onboarding");
  let rows: ChatRow[];
  try {
    rows = await chatRows(ctx, "main");
  } catch (e) {
    console.error("Chat unavailable:", e);
    return (
      <div className={`${card} mx-auto max-w-md px-6 py-12 text-center`}>
        <p className="text-sm text-slate-600">Chat isn&apos;t available yet.</p>
        <Link href="/" className={`mt-5 inline-flex rounded-lg px-3.5 py-2 text-sm font-medium ${btn.primary}`}>
          Go to Today
        </Link>
      </div>
    );
  }
  return <Chat mode="main" initial={rows} />;
}
