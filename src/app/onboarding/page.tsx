import { OnboardingFlow } from "@/components/onboarding/flow";
import { requireCtx } from "@/lib/auth";
import { hasDemoData } from "@/lib/demo";
import { DEFAULT_PROFILE, getProfile } from "@/lib/profile";

export const dynamic = "force-dynamic";
// The final step runs extraction, enrichment, matching and drafting through server actions.
export const maxDuration = 300;

/** One-time setup as a step-by-step wizard. (The Me page edits the same answers as a form; /chat fills in the network afterwards.) */
export default async function OnboardingPage() {
  const ctx = await requireCtx();
  const [profile, contacts, demo] = await Promise.all([
    getProfile(ctx),
    ctx.db.from("contacts").select("id", { count: "exact", head: true }).eq("owner_id", ctx.ownerId),
    hasDemoData(ctx),
  ]);
  return (
    <OnboardingFlow
      initial={{ ...DEFAULT_PROFILE, ...profile }}
      existingContacts={contacts.count ?? 0}
      hasDemo={demo}
      webEnrichment={Boolean(process.env.TAVILY_API_KEY)}
    />
  );
}
