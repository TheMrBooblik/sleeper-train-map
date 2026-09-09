// scripts/lib/describe-error.mjs
// Turn a thrown error into a line a later reader can act on.
//
// undici reports every transport-level failure as the same "fetch failed" and
// puts the reason in err.cause — and for a dual-stack host as an AggregateError
// carrying one failure per address it tried. The scrape runner recorded only
// err.message, so six consecutive nights of the CFR source failing wrote the
// string "fetch failed" and nothing else: DNS, TLS, a refused connection and a
// timeout were indistinguishable after the fact, and the one artifact that
// survives a run (source-health.json) said nothing a fix could start from.
//
// So the cause chain is unwrapped here and the system fields that name the
// actual failure (code/syscall/hostname/address/port) are appended. The result
// goes to the nightly log AND to source-health.json's lastError, which the
// integration dashboard shows — hence the length cap. It never throws: a
// describer that died on an odd error object would take down the source it was
// meant to explain.

const MAX_LENGTH = 400;
const MAX_DEPTH = 5;

// Node's system errors carry the diagnosis in these, not in the message.
const SYSTEM_FIELDS = [
  "code",
  "errno",
  "syscall",
  "hostname",
  "address",
  "port",
  "status",
];

function fieldsOf(err) {
  const out = [];
  for (const key of SYSTEM_FIELDS) {
    const value = err?.[key];
    if (value === undefined || value === null || value === "") continue;
    out.push(`${key}=${value}`);
  }
  return out.join(" ");
}

function messageOf(err) {
  if (typeof err === "string") return err;
  const message =
    typeof err?.message === "string" && err.message ? err.message : String(err);
  const fields = fieldsOf(err);
  return fields ? `${message} (${fields})` : message;
}

/**
 * @param {unknown} err
 * @returns {string} single line, e.g.
 *   `fetch failed ← [getaddrinfo ENOTFOUND data.gov.ro (code=ENOTFOUND …); …]`
 */
export function describeError(err) {
  try {
    const parts = [];
    const seen = new Set();
    let current = err;
    for (let depth = 0; current && depth < MAX_DEPTH; depth += 1) {
      if (typeof current === "object") {
        if (seen.has(current)) break; // a cause chain may loop back on itself
        seen.add(current);
      }
      parts.push(messageOf(current));
      // An AggregateError names one failure per address tried — the dual-stack
      // case, where the IPv6 and IPv4 attempts fail for different reasons.
      const aggregated = Array.isArray(current?.errors) ? current.errors : null;
      if (aggregated?.length) {
        parts.push(`[${[...new Set(aggregated.map(messageOf))].join("; ")}]`);
        break;
      }
      current = current?.cause;
    }
    const line = parts.filter(Boolean).join(" ← ") || String(err);
    return line.length > MAX_LENGTH
      ? `${line.slice(0, MAX_LENGTH - 1)}…`
      : line;
  } catch {
    return String(err?.message ?? err ?? "unknown error");
  }
}
