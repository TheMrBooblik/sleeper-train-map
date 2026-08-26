import { NextResponse } from "next/server";
import { isLocalAdminRequest } from "./lib/localAdmin.mjs";

export function middleware(request) {
  if (isLocalAdminRequest(request)) return NextResponse.next();

  // Look like the path does not exist. Do not advertise an admin surface.
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.rewrite(new URL("/404", request.url));
}

export const config = {
  // /data is the admin page. Public JSON under /data/* (gtfs, polylines) stays open.
  matcher: ["/data", "/api/admin/:path*", "/api/data-status"],
};
