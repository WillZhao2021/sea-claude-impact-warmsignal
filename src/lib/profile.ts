import { must, type Ctx } from "./supabase";

// The user's onboarding answers: what they offer, their goal, ideal clients and outreach rhythm.
// Used to personalize matching and drafting, and to size the daily briefing.

export const OFFERS = [
  ["marketing", "Marketing & growth"],
  ["sales", "Sales & business development"],
  ["finance", "Finance & accounting"],
  ["legal", "Legal"],
  ["it", "IT & cybersecurity"],
  ["software", "Software & tech"],
  ["consulting", "Consulting & strategy"],
  ["coaching", "Coaching & training"],
  ["hr", "HR & recruiting"],
  ["investing", "Investing & fundraising"],
  ["realestate", "Real estate"],
  ["creative", "Design & creative"],
] as const;

// Two moves: make an introduction (give), or ask for a meeting or an introduction (ask).
export const GOALS = [
  { id: "give", name: "Make intros", sub: "Connect people in your network who should meet" },
  { id: "ask", name: "Ask for meetings and intros", sub: "Reach people who can help you, directly or through someone you know" },
] as const;

/**
 * Goals from before there were only two moves. They're read as "ask", and "referrals" is also what
 * "ask" is stored as until the migration allowing "ask" is applied (saveProfile).
 */
const LEGACY_ASK_GOALS = new Set(["clients", "referrals", "winback", "partners"]);

export const INDUSTRIES = [
  "Software / SaaS",
  "Healthcare",
  "Fintech & financial services",
  "Consumer & retail",
  "Logistics & supply chain",
  "Managed IT / cybersecurity",
  "Legal & professional services",
  "Real estate",
  "Media & events",
  "Coaching & consulting",
  "Venture capital",
  "Other",
] as const;

export const ROLES = [
  ["owner", "Founder / CEO / owner"],
  ["csuite", "Other C-suite"],
  ["vp", "VP / director / partner"],
  ["manager", "Manager"],
  ["ic", "Individual contributor"],
  ["investor", "Investor"],
] as const;

export const REVENUE = [
  ["any", "Any size"],
  ["lt5", "Under $5M"],
  ["5-10", "$5M–$10M"],
  ["10-20", "$10M–$20M"],
  ["20-50", "$20M–$50M"],
  ["50+", "$50M+"],
] as const;

export type Goal = (typeof GOALS)[number]["id"];
export type Tone = "warm" | "professional" | "brief";

export type Profile = {
  full_name: string | null;
  offers: string[];
  offer_line: string | null;
  goal: Goal | null;
  industries: string[];
  roles: string[];
  revenue: string[];
  per_day: number;
  asks_per_week: number;
  gives_per_ask: number;
  rest_days: number;
  tone: Tone;
  onboarded_at: string | null;
};

export const DEFAULT_PROFILE: Profile = {
  full_name: null,
  offers: [],
  offer_line: null,
  goal: null,
  industries: [],
  roles: [],
  revenue: ["any"],
  per_day: 5,
  asks_per_week: 2,
  gives_per_ask: 2,
  rest_days: 14,
  tone: "warm",
  onboarded_at: null,
};

export async function getProfile(ctx: Ctx): Promise<Profile | null> {
  const { data, error } = await ctx.db.from("profiles").select("*").eq("owner_id", ctx.ownerId).maybeSingle();
  if (error) throw new Error(error.message);
  const p = data as (Omit<Profile, "goal"> & { goal: string | null }) | null;
  return p && { ...p, goal: p.goal && LEGACY_ASK_GOALS.has(p.goal) ? "ask" : (p.goal as Profile["goal"]) };
}

export async function saveProfile(ctx: Ctx, patch: Partial<Profile>): Promise<void> {
  const upsert = (p: Record<string, unknown>) =>
    ctx.db.from("profiles").upsert({ ...p, owner_id: ctx.ownerId, updated_at: new Date().toISOString() }, { onConflict: "owner_id" });
  let res = await upsert(patch);
  // Until migration 20261026050000 allows "ask", store it as the legacy "referrals" (read back as "ask").
  if (res.error && patch.goal === "ask" && /goal/.test(res.error.message)) res = await upsert({ ...patch, goal: "referrals" });
  must(res);
}

/** "Fractional CMO for B2B service firms", or the picked categories, or a neutral fallback. */
export function offerLine(p: Profile | null): string {
  const line = p?.offer_line?.trim();
  if (line) return line;
  const labels = OFFERS.filter(([id]) => p?.offers.includes(id)).map(([, label]) => label);
  return labels.length ? labels.join(", ") : "professional services";
}

/** A short description of the user for prompts. Profile answers are context, never facts about contacts. */
export function profilePrompt(p: Profile | null): string {
  if (!p) return "The user is a relationship-driven professional who likes to help people in their network.";
  const goal = GOALS.find((g) => g.id === p.goal);
  const roles = ROLES.filter(([id]) => p.roles.includes(id)).map(([, l]) => l);
  const ideal = [p.industries.join(", "), roles.join(", ")].filter(Boolean).join("; ");
  return [
    p.full_name ? `The user's name is ${p.full_name}.` : null,
    `The user offers: ${offerLine(p)}.`,
    goal
      ? `Their current goal: ${goal.name.toLowerCase()} (${goal.sub.toLowerCase()}).`
      : "Their goal: cultivate their network. Stay in touch, keep relationships warm, and help where they can.",
    ideal ? `Their ideal clients: ${ideal}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** How drafted messages end: signed with the user's first name, or unsigned if we don't know it. */
export function signOffInstruction(p: Profile | null): string {
  const first = p?.full_name?.trim().split(/\s+/)[0];
  return first
    ? `End the message with a line containing only "${first}" as the sign-off (no "Best," or other closing word unless it fits the tone).`
    : "Don't add a signature line.";
}
