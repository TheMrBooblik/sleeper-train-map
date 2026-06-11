// components/Admin/proposalDiff.js
// Dependency-free flat diff between a proposal's before/after values.
// Objects are flattened to dot-paths; rows are { key, before, after, op }.

function flatten(value, prefix = "", out = {}) {
  if (value === null || value === undefined || typeof value !== "object") {
    out[prefix || "value"] = value;
    return out;
  }
  if (Array.isArray(value)) {
    out[prefix || "value"] = JSON.stringify(value);
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      flatten(v, key, out);
    } else {
      out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
    }
  }
  return out;
}

export function diffProposal(before, after) {
  const a = flatten(before ?? {});
  const b = flatten(after ?? {});
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys
    .map((key) => {
      const hasA = key in a;
      const hasB = key in b;
      if (hasA && hasB && a[key] === b[key]) return null;
      return {
        key,
        before: hasA ? a[key] : undefined,
        after: hasB ? b[key] : undefined,
        op: !hasA ? "added" : !hasB ? "removed" : "changed",
      };
    })
    .filter(Boolean);
}
