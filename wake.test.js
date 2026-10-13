// Run: node --test
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { sendWake } = require("./wake.js");

const RELAY = { gh: "github_pat_SECRET", repo: "owner/rf-launcher" };
const HOOK = { url: "https://hooks.example/wake", key: "crsr_SECRET" };
// fake fetch: answers by host; "throw" means the browser blocked the call
const fake = (answers, calls = []) => async (url) => {
  const host = new URL(url).host; calls.push(host);
  const a = answers[host];
  if (a === "throw") throw new TypeError("Failed to fetch");
  return { ok: a >= 200 && a < 300, status: a, json: async () => ({}) };
};

test("relay first when a token is set", async () => {
  const calls = [];
  const r = await sendWake({ ...RELAY, ...HOOK }, fake({ "api.github.com": 204 }, calls));
  assert.deepStrictEqual(r, { via: "relay", warning: "" });
  assert.deepStrictEqual(calls, ["api.github.com"]);
});

test("a rejected relay token (401) says so and falls back to the webhook", async () => {
  const r = await sendWake({ ...RELAY, ...HOOK }, fake({ "api.github.com": 401, "hooks.example": 200 }));
  assert.strictEqual(r.via, "direct");
  assert.match(r.warning, /HTTP 401.*Settings/);
});

test("a rejected relay token with no webhook points to Settings", async () => {
  await assert.rejects(sendWake(RELAY, fake({ "api.github.com": 401 })), (e) => e.settings && /401/.test(e.message) && /Settings/.test(e.message));
});

test("both failing reports both, and no secret ever appears in a message", async () => {
  await assert.rejects(sendWake({ ...RELAY, ...HOOK }, fake({ "api.github.com": 401, "hooks.example": "throw" })), (e) =>
    /401/.test(e.message) && /blocked/.test(e.message) && !e.message.includes("SECRET"));
});

test("webhook only, and nothing set up at all", async () => {
  assert.strictEqual((await sendWake(HOOK, fake({ "hooks.example": 200 }))).via, "direct");
  await assert.rejects(sendWake({}, fake({})), (e) => e.settings);
});
