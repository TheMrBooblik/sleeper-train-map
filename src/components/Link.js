// next/link with viewport prefetching off.
//
// In production a Pages Router <Link> prefetches its target's page data
// (/_next/data/<build>/….json) and route chunk as soon as the link scrolls
// into view. The SEO pages are lists of links, so one visit fired dozens of
// requests for pages nobody opened: 57 of the homepage's 118, 72 of
// /connections' 114. Every one counts against Vercel Hobby's 1M CDN requests
// a month, which the site hit in October 2026. With prefetch={false} Next
// still prefetches on hover, so the page a visitor is about to open is warm.
//
// Import this instead of next/link; tests/verify-cdn-requests.mjs fails on a
// direct import. Pass prefetch explicitly where eager prefetch is worth it.
import NextLink from "next/link";
import { forwardRef } from "react";

const Link = forwardRef(function Link({ prefetch = false, ...props }, ref) {
  return <NextLink ref={ref} prefetch={prefetch} {...props} />;
});

export default Link;
