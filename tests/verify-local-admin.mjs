// Unit tests for the loopback-only admin gate. Run: npm run verify-local-admin
import assert from "node:assert/strict";
import { isLocalAdmin } from "../src/lib/localAdmin.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

check("localhost is allowed", () => {
  assert.equal(isLocalAdmin({ host: "localhost:3000" }), true);
});
check("127.0.0.1 is allowed", () => {
  assert.equal(isLocalAdmin({ host: "127.0.0.1:3000" }), true);
});
check("IPv6 loopback is allowed", () => {
  assert.equal(isLocalAdmin({ host: "[::1]:3000" }), true);
});
check("loopback host + loopback IP is allowed", () => {
  assert.equal(isLocalAdmin({ host: "localhost:3000", ip: "127.0.0.1" }), true);
});
check("IPv4-mapped IPv6 loopback is allowed", () => {
  assert.equal(
    isLocalAdmin({ host: "localhost:3000", ip: "::ffff:127.0.0.1" }),
    true,
  );
});

check("production host is denied", () => {
  assert.equal(isLocalAdmin({ host: "pingwi.com" }), false);
});
check("LAN host is denied", () => {
  assert.equal(isLocalAdmin({ host: "192.168.1.5:3000" }), false);
});
check("missing host is denied", () => {
  assert.equal(isLocalAdmin({}), false);
});
check("Vercel is denied even with localhost Host", () => {
  assert.equal(isLocalAdmin({ host: "localhost:3000", vercel: true }), false);
});
check("spoofed localhost Host from a LAN IP is denied in production", () => {
  assert.equal(
    isLocalAdmin({ host: "localhost:3000", ip: "192.168.1.20" }),
    false,
  );
});
check("next dev allows loopback Host even if request.ip is a proxy address", () => {
  assert.equal(
    isLocalAdmin({ host: "localhost:3000", ip: "192.168.1.20", dev: true }),
    true,
  );
});

console.log(`verify-local-admin: ${passed} passed`);
