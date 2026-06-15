// scripts/lib/text-similarity.mjs
// Tiny dependency-free string-distance helpers shared by the AI station matcher
// (scripts/ai-tasks.mjs) and the deterministic duplicate detector
// (scripts/lib/duplicate-detect.mjs). Kept in its own module so the detector
// doesn't have to import the AI-tasks file (which pulls in github-content/fs).

// Capped Levenshtein edit distance. Returns cap+1 as soon as the strings are
// clearly too far apart (length gap alone exceeds the cap), so callers can use
// it as a cheap "are these within N edits" gate.
export function levenshtein(a, b, cap = 6) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = tmp;
    }
  }
  return prev[b.length];
}
