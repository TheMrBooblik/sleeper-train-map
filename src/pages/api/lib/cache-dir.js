/**
 * Cache directory helper for API routes.
 * On Vercel the filesystem is read-only except /tmp, so we use /tmp to avoid 500s.
 * In local/dev we use .next/cache for persistence.
 */
import path from "path";

const IS_VERCEL = process.env.VERCEL === "1";

export function getCacheDir(subdir) {
  if (IS_VERCEL) {
    return path.join("/tmp", "train-map-cache", subdir);
  }
  return path.join(process.cwd(), ".next", "cache", subdir);
}

export function ensureDir(fs, dir) {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return true;
  } catch {
    return false;
  }
}
