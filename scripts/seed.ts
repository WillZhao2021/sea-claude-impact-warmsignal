// Runs the full live pipeline on the sample dataset for one account:
// contacts CSV + public figures -> Claude extraction of notes -> Tavily enrichment -> matching -> drafts.
//
// Usage:
//   npm run seed -- --email you@example.com            load sample data into that account
//   npm run seed -- --email you@example.com --reset    wipe that account's contacts first
//   npm run seed -- --email you@example.com --export   also write data/demo_snapshot.json
//                                                      (what "Load demo contacts" copies; no API calls)
import { readFileSync, writeFileSync } from "node:fs";
import { defaultEvalDate } from "../src/lib/briefing";
import { importContactsCsv } from "../src/lib/contacts";
import { ensureDrafts } from "../src/lib/draft";
import { enrichPending } from "../src/lib/enrich";
import { ingestNote } from "../src/lib/extract";
import { findIntroductions } from "../src/lib/match";
import { must, serviceCtx, serviceDb, type Ctx } from "../src/lib/supabase";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function userIdFor(email: string): Promise<string> {
  for (let page = 1; ; page++) {
    const { data, error } = await serviceDb().auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const user = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (user) return user.id;
    if (data.users.length < 200) throw new Error(`No account for ${email}. Sign up in the app first.`);
  }
}

async function seed(ctx: Ctx) {
  if (process.argv.includes("--reset")) {
    must(await ctx.db.from("contacts").delete().eq("owner_id", ctx.ownerId)); // cascades
    console.log("Reset this account's data");
  }

  const n = await importContactsCsv(ctx, readFileSync("data/contacts.csv", "utf8"));
  // Real public figures, enrichment demo only: no notes, strength 1, never introduced.
  const pub = await importContactsCsv(ctx, readFileSync("data/public_figures.csv", "utf8"));
  console.log(`Imported ${n} contacts + ${pub} public figures`);

  const contacts = must<{ id: string; external_id: string }[]>(
    await ctx.db.from("contacts").select("id, external_id").eq("owner_id", ctx.ownerId),
  );
  const idFor = new Map(contacts.map((c) => [c.external_id, c.id]));
  const existing = must<{ contact_id: string; date: string }[]>(
    await ctx.db.from("interactions").select("contact_id, date").eq("owner_id", ctx.ownerId),
  );
  const notes: { contact_id: string; date: string; notes: string }[] = JSON.parse(
    readFileSync("data/notes.json", "utf8"),
  );
  const todo = notes
    .map((x) => ({ ...x, id: idFor.get(x.contact_id)! }))
    .filter((x) => x.id && !existing.some((e) => e.contact_id === x.id && e.date === x.date));

  for (let i = 0; i < todo.length; i += 5) {
    await Promise.all(
      todo.slice(i, i + 5).map(async (x) => {
        await ingestNote(ctx, x.id, x.date, x.notes);
        console.log(`Extracted note for ${x.contact_id} (${x.date})`);
      }),
    );
  }

  if (process.env.TAVILY_API_KEY) {
    console.log(`Enriched ${await enrichPending(ctx)} contacts from the web`);
  } else {
    console.log("TAVILY_API_KEY not set: skipping web enrichment");
  }

  const result = await findIntroductions(ctx);
  console.log(`Assessed ${result.matches} candidate introductions across ${result.needs} needs`);
  await ensureDrafts(ctx, defaultEvalDate());
  console.log("Drafted outreach for today's briefing");
}

/** Writes the account's sample-data rows to data/demo_snapshot.json (keys = CSV ids / old row ids). */
async function exportSnapshot(ctx: Ctx) {
  const get = async (table: string) =>
    must<Record<string, unknown>[]>(
      await ctx.db.from(table).select("*").eq("owner_id", ctx.ownerId).order("created_at").order("id"),
    );
  const [contacts, interactions, signals, opps] = await Promise.all(
    ["contacts", "interactions", "signals", "opportunities"].map(get),
  );
  const demo = contacts.filter((c) => c.external_id);
  const ext = new Map(demo.map((c) => [c.id as string, c.external_id as string]));
  const omit = (o: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
  const common = ["id", "owner_id", "created_at"];

  const snap = {
    note:
      "Processed demo dataset (fictional contacts + public figures). Regenerate with: npm run seed -- --email <account> --reset --export. Drafts are not included: they are generated per user, in their voice.",
    contacts: demo.map((c) => ({ ...omit(c, common), outreach_draft: null, outreach_draft_mode: null })),
    interactions: interactions
      .filter((i) => ext.has(i.contact_id as string))
      .map((i) => ({ key: i.id, contact: ext.get(i.contact_id as string), ...omit(i, [...common, "contact_id"]) })),
    signals: signals
      .filter((s) => ext.has(s.contact_id as string))
      .map((s) => ({
        key: s.id,
        contact: ext.get(s.contact_id as string),
        interaction: s.interaction_id,
        ...omit(s, [...common, "contact_id", "interaction_id"]),
      })),
    opportunities: opps
      .filter((o) => ext.has(o.recipient_contact_id as string) && ext.has(o.proposed_contact_id as string))
      .map((o) => ({
        recipient: ext.get(o.recipient_contact_id as string),
        proposed: ext.get(o.proposed_contact_id as string),
        need: o.matched_need_id,
        offer: o.matched_offer_id,
        ...omit(o, [
          ...common,
          "updated_at",
          "recipient_contact_id",
          "proposed_contact_id",
          "matched_need_id",
          "matched_offer_id",
        ]),
        // Drafts are written per user, in their own voice and tone, not shipped in the snapshot.
        draft_message: null,
        draft_kind: null,
      })),
  };
  writeFileSync("data/demo_snapshot.json", JSON.stringify(snap, null, 1));
  console.log(`Wrote data/demo_snapshot.json (${snap.contacts.length} contacts, ${snap.opportunities.length} intros)`);
}

async function main() {
  const email = arg("--email");
  if (!email) throw new Error("Usage: npm run seed -- --email you@example.com [--reset] [--export]");
  const ctx = serviceCtx(await userIdFor(email));
  await seed(ctx);
  if (process.argv.includes("--export")) await exportSnapshot(ctx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
