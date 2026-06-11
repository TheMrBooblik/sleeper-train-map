// scripts/lib/ai.mjs
// Minimal GitHub Models client for the nightly batch jobs. Free tier: runs in
// GitHub Actions with the built-in GITHUB_TOKEN (`models: read` permission).
//
// Design rules (the pipeline must never depend on AI):
//   • hard per-run request budget (AI_MAX_REQUESTS, default 40)
//   • ≥4.5s spacing between calls (free tier is ~15 req/min)
//   • model fallback list; any failure → try next model
//   • returns null on ANY failure — callers treat null as "skip"

const AI_ENDPOINT = "https://models.github.ai/inference/chat/completions";

const DEFAULT_MODELS = [
  "openai/gpt-4o-mini",
  "openai/gpt-4.1-mini",
  "microsoft/phi-4-mini-instruct",
];

const MIN_SPACING_MS = 4_500;
const REQUEST_TIMEOUT_MS = 30_000;

let budget = Number(process.env.AI_MAX_REQUESTS ?? 40);
let lastCallAt = 0;

export function aiAvailable() {
  return Boolean(process.env.GITHUB_TOKEN) && budget > 0;
}

export function remainingBudget() {
  return budget;
}

function models() {
  const fromEnv = (process.env.AI_MODELS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_MODELS;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Models often wrap JSON in fences or prose — extract the first JSON object.
export function extractJson(content) {
  if (!content || typeof content !== "string") return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : content;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * One JSON-producing chat completion. Returns the parsed object or null.
 * @param {{ system: string, user: string, maxTokens?: number }} args
 */
export async function aiJson({ system, user, maxTokens = 800 }) {
  if (!aiAvailable()) return null;

  const wait = lastCallAt + MIN_SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);

  for (const model of models()) {
    if (budget <= 0) return null;
    budget -= 1;
    lastCallAt = Date.now();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const res = await fetch(AI_ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      }).finally(() => clearTimeout(timer));

      if (!res.ok) {
        console.warn(`[ai] ${model} → HTTP ${res.status}`);
        if (res.status === 429) await sleep(MIN_SPACING_MS);
        continue; // next model
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      const parsed = extractJson(content);
      if (parsed) return parsed;
      console.warn(`[ai] ${model} → unparseable response`);
    } catch (err) {
      console.warn(`[ai] ${model} → ${err.message}`);
    }
  }
  return null;
}
