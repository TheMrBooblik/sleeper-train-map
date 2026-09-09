// scripts/lib/probe-reachability.mjs
// Answer "can this host be reached at all, and if not, at which layer?"
//
// Every probe workflow exists because the sandbox has no egress to the host in
// question, so CI is the only place the answer can be obtained — and a probe
// that dies on an unhandled `fetch failed` delivers nothing. undici collapses
// DNS, TCP, TLS and HTTP failures into that one string, but each has a
// different fix, so this walks the layers separately and reports every step
// instead of summing them into a pass/fail.
//
// Dependency-free (raw node, like the rest of scripts/lib) and it never
// throws: triage that fails would take down the probe it is meant to explain.

import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import { describeError } from "./describe-error.mjs";

const TLS_TIMEOUT_MS = 15_000;

function tlsProbe(host, address, timeoutMs) {
  return new Promise((resolve) => {
    const family = net.isIPv6(address) ? 6 : 4;
    let socket;
    const done = (ok, detail) => {
      try {
        socket?.destroy();
      } catch {
        /* already gone */
      }
      resolve({ layer: "tls", family, address, ok, detail });
    };
    try {
      // Connect by address but present the hostname as SNI: that is what
      // separates "the host is unreachable" from "this address is".
      socket = tls.connect(
        { host: address, port: 443, servername: host, timeout: timeoutMs },
        () => done(true, socket.getProtocol() ?? "connected"),
      );
      socket.once("timeout", () => done(false, `timeout after ${timeoutMs}ms`));
      socket.once("error", (err) => done(false, describeError(err)));
    } catch (err) {
      done(false, describeError(err));
    }
  });
}

/**
 * @param {string} host
 * @param {{log?: (line: string) => void, timeoutMs?: number}} [options]
 * @returns {Promise<Array<{layer: string, family?: number, address?: string, ok: boolean, detail: string}>>}
 */
export async function reportReachability(host, options = {}) {
  const log = options.log ?? ((line) => console.log(line));
  const timeoutMs = options.timeoutMs ?? TLS_TIMEOUT_MS;
  const steps = [];
  log(`=== reachability: ${host} ===`);

  const addresses = [];
  for (const family of [4, 6]) {
    try {
      const found = await dns.lookup(host, { family, all: true });
      const list = found.map((a) => a.address);
      list.forEach((a) => addresses.push(a));
      steps.push({
        layer: "dns",
        family,
        ok: list.length > 0,
        detail: list.join(", ") || "(none)",
      });
      log(`  DNS IPv${family}: ${list.join(", ") || "(none)"}`);
    } catch (err) {
      const detail = describeError(err);
      steps.push({ layer: "dns", family, ok: false, detail });
      log(`  DNS IPv${family}: FAILED — ${detail}`);
    }
  }

  for (const address of addresses) {
    const step = await tlsProbe(host, address, timeoutMs);
    steps.push(step);
    log(
      `  TLS IPv${step.family} ${address}: ${step.ok ? `ok (${step.detail})` : `FAILED — ${step.detail}`}`,
    );
  }

  log(`  → ${summarize(steps)}`);
  return steps;
}

/** One sentence naming the layer that broke, and therefore which fix applies. */
export function summarize(steps) {
  const dnsSteps = steps.filter((s) => s.layer === "dns");
  const tlsSteps = steps.filter((s) => s.layer === "tls");
  if (dnsSteps.length && dnsSteps.every((s) => !s.ok)) {
    return "DNS does not resolve — resolver or blocklist, not the adapter.";
  }
  if (!tlsSteps.length) return "resolved, but no address was testable.";
  const okFamilies = new Set(tlsSteps.filter((s) => s.ok).map((s) => s.family));
  const badFamilies = new Set(
    tlsSteps.filter((s) => !s.ok).map((s) => s.family),
  );
  if (!okFamilies.size) {
    return "resolves but no address completes TLS — the host is blocking or unreachable from here.";
  }
  if (okFamilies.has(4) && badFamilies.has(6) && !okFamilies.has(6)) {
    return "IPv4 connects, IPv6 does not — dual-stack: pin the family in the adapter.";
  }
  if (okFamilies.has(6) && badFamilies.has(4) && !okFamilies.has(4)) {
    return "IPv6 connects, IPv4 does not — dual-stack, inverted.";
  }
  return "TLS reaches the host — a failure above this line is HTTP-layer (WAF, User-Agent, geo-block).";
}
