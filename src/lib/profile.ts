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

export const GOALS = [
  { id: "give", name: "Give first: make intros", sub: "Help people in your network meet each other" },
  { id: "clients", name: "Find new clients", sub: "People who need what you offer or match your ideal client" },
  { id: "referrals", name: "Get referrals", sub: "Warm contacts who can introduce you to others" },
  { id: "winback", name: "Win back past clients", sub: "Past clients and relationships that went quiet" },
  { id: "partners", name: "Find partners", sub: "People who serve the same clients you do" },
] as const;

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
  return data as Profile | null;
}

export async function saveProfile(ctx: Ctx, patch: Partial<Profile>): Promise<void> {
  must(
    await ctx.db
      .from("profiles")
      .upsert({ ...patch, owner_id: ctx.ownerId, updated_at: new Date().toISOString() }, { onConflict: "owner_id" }),
  );
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
    `The user offers: ${offerLine(p)}.`,
    goal ? `Their current goal: ${goal.name.toLowerCase()} (${goal.sub.toLowerCase()}).` : null,
    ideal ? `Their ideal clients: ${ideal}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}
