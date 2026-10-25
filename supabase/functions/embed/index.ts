// Text embeddings with Supabase's built-in gte-small model (384 dims, normalized).
// POST { input: string[] } -> { embeddings: number[][] }. Requires a signed-in user's JWT
// (verify_jwt is on by default), so it isn't a free public endpoint.

// Types for the `Supabase` global that the Edge Runtime provides.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const session = new Supabase.ai.Session("gte-small");

const MAX_INPUTS = 8; // with callers packing by size (src/lib/vectors.ts), keeps requests inside the CPU limit

Deno.serve(async (req) => {
  const { input } = await req.json().catch(() => ({ input: null }));
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_INPUTS || !input.every((t) => typeof t === "string")) {
    return Response.json({ error: `input must be 1-${MAX_INPUTS} strings` }, { status: 400 });
  }
  const embeddings: number[][] = [];
  for (const text of input) {
    embeddings.push(Array.from((await session.run(text, { mean_pool: true, normalize: true })) as number[]));
  }
  return Response.json({ embeddings });
});
