// tests/verify-download-file.mjs
// downloadFile's failure paths, exercised against real local servers.
//
// The case that motivated the timeout: data.gov.ro accepts nothing and refuses
// nothing from a GitHub runner — it drops the packets. https.get with no
// timeout then waits for the OS to abandon the TCP connection, minutes past the
// 30s its caller expects, with four adapters and the CFR probe on this path.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { downloadFile } from "../scripts/lib/gtfs.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-download-"));
const dest = (name) => path.join(tmp, name);
let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
// server.close() waits for every live connection before calling back, and the
// silent server is still holding the accepted socket. http.Server can drop them
// itself; a bare net.Server cannot, so its sockets are tracked and destroyed.
const closed = (server, sockets = []) =>
  new Promise((resolve) => {
    server.closeAllConnections?.();
    sockets.forEach((socket) => socket.destroy());
    server.close(resolve);
  });

await check(
  "a silent host is bounded by the timeout, not by the OS",
  async () => {
    // Accepts the TCP connection and then says nothing, so the request never
    // completes — only an inactivity timeout can end this. This is the shape of
    // the CFR failure: 10.49s to fail on two different days, an 8ms spread.
    const sockets = [];
    const server = net.createServer((socket) => sockets.push(socket));
    const port = await listen(server);
    const target = dest("silent.bin");
    const started = Date.now();
    try {
      await downloadFile(`http://127.0.0.1:${port}/x`, target, {
        timeoutMs: 300,
      });
      assert.fail("expected a timeout");
    } catch (err) {
      assert.equal(err.code, "ETIMEDOUT", err.message);
      assert.match(err.message, /timed out after 300ms/);
      assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);
      // A partial file must not survive: a later read would treat it as data.
      assert.equal(fs.existsSync(target), false);
    } finally {
      await closed(server, sockets);
    }
  },
);

await check("a 404 rejects and leaves no 0-byte artifact", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end("nope");
  });
  const port = await listen(server);
  const target = dest("missing.bin");
  await assert.rejects(
    () =>
      downloadFile(`http://127.0.0.1:${port}/x`, target, { timeoutMs: 2000 }),
    /HTTP 404/,
  );
  assert.equal(fs.existsSync(target), false);
  await closed(server);
});

await check(
  "a redirect loop is capped instead of recursing forever",
  async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits += 1;
      res.writeHead(302, { Location: "/loop" });
      res.end();
    });
    const port = await listen(server);
    const target = dest("loop.bin");
    await assert.rejects(
      () =>
        downloadFile(`http://127.0.0.1:${port}/start`, target, {
          timeoutMs: 2000,
        }),
      /Too many redirects/,
    );
    // One initial request plus the capped follows — bounded, not runaway.
    assert.ok(hits >= 2 && hits <= 7, `server saw ${hits} requests`);
    assert.equal(fs.existsSync(target), false);
    await closed(server);
  },
);

await check(
  "a relative Location is resolved against the current URL",
  async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/here") {
        res.writeHead(302, { Location: "/there" }); // relative, as many servers send
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("arrived");
    });
    const port = await listen(server);
    const target = dest("relative.txt");
    await downloadFile(`http://127.0.0.1:${port}/here`, target, {
      timeoutMs: 2000,
    });
    assert.equal(fs.readFileSync(target, "utf8"), "arrived");
    await closed(server);
  },
);

await check("a plain 200 still downloads its body intact", async () => {
  const body = "Tren,Trasa,ElementTrasa\n".repeat(500);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(body);
  });
  const port = await listen(server);
  const target = dest("ok.xml");
  await downloadFile(`http://127.0.0.1:${port}/f.xml`, target, {
    timeoutMs: 2000,
  });
  assert.equal(fs.readFileSync(target, "utf8"), body);
  await closed(server);
});

console.log(`\n[verify-download-file] ${passed} checks passed`);
fs.rmSync(tmp, { recursive: true, force: true });
