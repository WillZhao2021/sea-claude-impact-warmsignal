import Link from "next/link";
import { Chat } from "@/components/chat/chat";
import { btn, card } from "@/components/ui";
import { requireCtx } from "@/lib/auth";
import { chatRows } from "@/lib/chat/agent";
import type { ChatRow } from "@/lib/chat/cards";
import { getProfile } from "@/lib/profile";

export const dynamic = "force-dynamic";
// Uploads (server action) can import and match hundreds of contacts.
export const maxDuration = 300;

export default async function ChatPage() {
  const ctx = await requireCtx();
  const profile = await getProfile(ctx);
  let rows: ChatRow[];
  try {
    rows = await chatRows(ctx);
  } catch (e) {
    // Most likely the chat_messages migration hasn't been applied yet: keep the classic flow usable.
    console.error("Chat unavailable:", e);
    return (
      <div className={`${card} mx-auto max-w-md px-6 py-12 text-center`}>
        <p className="text-sm text-slate-600">Chat isn&apos;t available yet.</p>
        <Link href={profile?.onboarded_at ? "/" : "/onboarding"} className={`mt-5 inline-flex rounded-lg px-3.5 py-2 text-sm font-medium ${btn.primary}`}>
          {profile?.onboarded_at ? "Go to Today" : "Set up with the form instead"}
        </Link>
      </div>
    );
  }
  return <Chat initial={rows} onboarded={!!profile?.onboarded_at} />;
}
