// Admin gate: /data and its APIs are loopback-only. No login, no cookies.
//
// Two independent checks, both required to pass:
//   1. Never on Vercel (production and preview). VERCEL=1 is set by the
//      platform, so a spoofed Host: localhost header cannot open the admin.
//   2. The Host header must be a loopback name. When the connecting IP is
//      known, it must be loopback too — otherwise someone on the LAN could
//      send Host: localhost to a next dev server bound on 0.0.0.0.
//
// Missing IP is allowed: local Next middleware often has no request.ip.
// Do not trust X-Forwarded-For; it is trivial to spoof.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostnameOf(hostHeader) {
  if (!hostHeader) return "";
  const raw = String(hostHeader).trim().toLowerCase();
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end === -1 ? raw : raw.slice(0, end + 1);
  }
  return raw.split(":")[0];
}

function isLoopbackIp(ip) {
  if (!ip) return false;
  const cleaned = String(ip)
    .trim()
    .replace(/^::ffff:/i, "")
    .replace(/^\[|\]$/g, "");
  return cleaned === "127.0.0.1" || cleaned === "::1" || cleaned === "localhost";
}

/**
 * Pure predicate. Pass `vercel` explicitly so tests do not touch process.env.
 * @param {{ host?: string, ip?: string, vercel?: boolean }} info
 */
export function isLocalAdmin({ host, ip, vercel } = {}) {
  if (vercel) return false;
  if (!LOOPBACK_HOSTS.has(hostnameOf(host))) return false;
  if (ip && !isLoopbackIp(ip)) return false;
  return true;
}

/** NextRequest (middleware) or Node IncomingMessage (API routes). */
export function isLocalAdminRequest(req) {
  const host =
    typeof req.headers?.get === "function"
      ? req.headers.get("host")
      : req.headers?.host;
  const ip = req.ip || req.socket?.remoteAddress || "";
  return isLocalAdmin({
    host,
    ip,
    vercel: Boolean(process.env.VERCEL),
  });
}

/** Send a blank 404 and return true when the caller should stop. */
export function rejectUnlessLocalAdmin(req, res) {
  if (isLocalAdminRequest(req)) return false;
  res.status(404).json({ error: "Not found" });
  return true;
}
