import { NextResponse } from "next/server";
import { isLocalAdminRequest } from "./lib/localAdmin.mjs";

function noStore(res) {
  res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  // localhost is a secure origin. Drop cached 307 /data→/login and 301 /login→/.
  res.headers.set("Clear-Site-Data", '"cache"');
  return res;
}

export function middleware(request) {
  const { pathname } = request.nextUrl;
  const local = isLocalAdminRequest(request);

  // Old middleware 307'd /data → /login. That 307 can live in the browser
  // cache. Send leftover /login hops back to /data on localhost (query
  // bypasses the cached /data URL). Anywhere else, hide the path.
  if (pathname === "/login" || pathname === "/login/") {
    if (!local) {
      return noStore(NextResponse.rewrite(new URL("/404", request.url)));
    }
    const dest = request.nextUrl.clone();
    dest.pathname = "/data";
    dest.search = "local=1";
    return noStore(NextResponse.redirect(dest, 303));
  }

  if (!local) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return noStore(NextResponse.rewrite(new URL("/404", request.url)));
  }

  return noStore(NextResponse.next());
}

export const config = {
  // /data is the admin page. Public JSON under /data/* (gtfs, polylines) stays open.
  matcher: ["/data", "/login", "/api/admin/:path*", "/api/data-status"],
};
