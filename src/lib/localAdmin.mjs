// Admin gate: /data and its APIs are loopback-only. No login, no cookies.
//
// Production lock: never on Vercel (VERCEL=1 is set by the platform).
// Local lock: Host must be a loopback name.
//
// Do not deny on request.ip during `next dev`. Next middleware often reports
// a non-loopback ip for a localhost Host (proxy, IPv6, docker), which 404'd
// /data and left browsers sitting on a cached /data → /login redirect.

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
 * Pure predicate. Pass `vercel` / `dev` explicitly so tests do not touch process.env.
 * @param {{ host?: string, ip?: string, vercel?: boolean, dev?: boolean }} info
 */
export function isLocalAdmin({ host, ip, vercel, dev } = {}) {
  if (vercel) return false;
  if (!LOOPBACK_HOSTS.has(hostnameOf(host))) return false;
  // `next dev`: Host is enough. IP is only a spoof check for `next start`.
  if (dev) return true;
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
    dev: process.env.NODE_ENV !== "production",
  });
}

/** Send a blank 404 and return true when the caller should stop. */
export function rejectUnlessLocalAdmin(req, res) {
  if (isLocalAdminRequest(req)) return false;
  res.status(404).json({ error: "Not found" });
  return true;
}
