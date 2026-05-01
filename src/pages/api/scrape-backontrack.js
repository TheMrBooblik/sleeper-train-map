// pages/api/scrape-backontrack.js
// Manual trigger: dispatches the scrape-data GitHub Actions workflow via workflow_dispatch.
// Requires GITHUB_TOKEN env var (PAT with `workflow` scope) and CRON_SECRET for auth.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const authHeader = req.headers["authorization"];
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (process.env.CRON_SECRET && authHeader !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return res.status(500).json({ error: "GITHUB_TOKEN not configured" });
  }

  const owner = process.env.VERCEL_GIT_REPO_OWNER || "TheMrBooblik";
  const repo = process.env.VERCEL_GIT_REPO_SLUG || "train-map";

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/scrape-data.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main" }),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    console.error("[scrape-backontrack] GitHub API error:", response.status, text);
    return res.status(502).json({ error: "GitHub API failed", status: response.status });
  }

  return res.status(200).json({ ok: true, triggered: true });
}
