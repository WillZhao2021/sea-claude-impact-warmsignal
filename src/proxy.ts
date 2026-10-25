import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Refreshes the Supabase session cookie on every request. Signed-out visitors to "/" see the
// landing page (/welcome); every other protected path sends them to /login.
// Pages and server actions also check the user themselves (requireCtx); this is the first gate.

const PUBLIC_PATHS = ["/login", "/signup", "/welcome"];

export async function proxy(request: NextRequest) {
  // Cron routes have no session; they authenticate with CRON_SECRET themselves.
  if (request.nextUrl.pathname.startsWith("/api/cron/")) return NextResponse.next();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet, headers) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value);
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);
  const isPublic = PUBLIC_PATHS.includes(request.nextUrl.pathname);

  if (!signedIn && !isPublic) {
    // API callers (fetch/SSE) need a status code, not a redirect to an HTML page.
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = request.nextUrl.pathname === "/" ? "/welcome" : "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  if (signedIn && isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  // Static files (images, models, fonts, video) skip the proxy so the public landing page can load them.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|avif|ico|glb|gltf|hdr|ktx2|woff2?|mp4|webm)$).*)",
  ],
};
