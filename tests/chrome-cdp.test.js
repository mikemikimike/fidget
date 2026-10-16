import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { launchWithPipe, createPageTarget, cleanupChrome } from "./chrome-cdp.js";

// A stand-in for Chrome that speaks CDP over fds 3 and 4. It ignores every call
// until `readyAfterMs` has passed, like a Chrome still starting, then answers
// only the methods in `answers`. Anything else gets no reply.
function fakeChrome(readyAfterMs, answers, stderr = "") {
  const dir = mkdtempSync(join(tmpdir(), "fake-chrome-"));
  const bin = join(dir, "chrome");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const answers = ${JSON.stringify(answers)};
const out = fs.createWriteStream(null, { fd: 4 });
const input = fs.createReadStream(null, { fd: 3, encoding: "utf8" });
process.stderr.write(${JSON.stringify(stderr)});
let buffer = "";
const queue = [];
function reply(msg) {
  if (msg.method in answers) {
    out.write(JSON.stringify({ id: msg.id, result: answers[msg.method] }) + "\\0");
  }
}
input.on("data", (chunk) => {
  buffer += chunk;
  const parts = buffer.split("\\0");
  buffer = parts.pop();
  for (const part of parts) {
    if (part) queue.push(JSON.parse(part));
  }
});
setTimeout(() => setInterval(() => { while (queue.length) reply(queue.shift()); }, 5), ${readyAfterMs});
setInterval(() => {}, 1000);
`);
  chmodSync(bin, 0o755);
  return { bin, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

const PAGE = {
  "Browser.getVersion": { product: "Fake/1" },
  "Target.createTarget": { targetId: "T1" },
  "Target.attachToTarget": { sessionId: "S1" },
  "Runtime.enable": {},
  "Log.enable": {},
  "Page.enable": {},
};

test("a Chrome that answers only after a slow start still gets a page", { timeout: 20000 }, async () => {
  const fake = fakeChrome(4000, PAGE);
  const cdp = launchWithPipe(fake.bin, []);
  try {
    const page = await createPageTarget(cdp);
    assert.equal(page.sessionId, "S1");
  } finally {
    await cleanupChrome(cdp);
    fake.dispose();
  }
});

test("once Chrome is ready, a page call it never answers fails within 3s and shows its stderr", { timeout: 20000 }, async () => {
  const { "Target.createTarget": _, ...rest } = PAGE;
  const fake = fakeChrome(4000, rest, "renderer stuck in GPU init");
  const cdp = launchWithPipe(fake.bin, []);
  try {
    await cdp.ready;
    const readyAt = Date.now();
    await assert.rejects(createPageTarget(cdp), /Target\.createTarget: CDP call timeout after 3000ms.*renderer stuck in GPU init/);
    const waited = Date.now() - readyAt;
    assert.ok(waited < 3500, `failed ${waited}ms after Chrome was ready`);
  } finally {
    await cleanupChrome(cdp);
    fake.dispose();
  }
});

test("a Chrome that exits while starting fails at once with its exit", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-chrome-"));
  const bin = join(dir, "chrome");
  writeFileSync(bin, "#!/bin/sh\necho 'no display' >&2\nsleep 0.2\nexit 3\n");
  chmodSync(bin, 0o755);
  const started = Date.now();
  const cdp = launchWithPipe(bin, []);
  try {
    await assert.rejects(createPageTarget(cdp), /Chrome exited with code 3.*no display|Chrome pipe closed/);
    assert.ok(Date.now() - started < 2000);
  } finally {
    await cleanupChrome(cdp);
    rmSync(dir, { recursive: true, force: true });
  }
});
