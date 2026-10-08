import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPayment, withPayCheck, wrapFetchWithPayCheck, reportOutcome, paymentTxFrom, consumeReceipt, getAgentCredential, verifyAgentCredential } from "../dist/index.js";
import { generateKeyPairSync, sign } from "node:crypto";

const fakePayCheck = (answer, status = 200, seen = []) => async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify(answer), { status }); };
const PAY = { url: "https://api.example.com/x", amount: "10000", payTo: "0xabc", network: "eip155:8453" };

test("free check: allow", async () => {
  const seen = [];
  const d = await checkPayment(PAY, { fetch: fakePayCheck({ allow: true, reasons: ["all rules passed"] }, 200, seen), apiKey: "pc_free_x" });
  assert.equal(d.allow, true);
  assert.match(seen[0].url, /\/v1\/check-payment$/);
  assert.equal(seen[0].init.headers["x-paycheck-key"], "pc_free_x");
});

test("free check: deny keeps reasons", async () => {
  const d = await checkPayment(PAY, { fetch: fakePayCheck({ allow: false, reasons: ["payTo differs from the monitored payout wallet (possible hijack)"] }) });
  assert.equal(d.allow, false); assert.equal(d.outcome, "deny"); assert.match(d.reasons[0], /hijack/);
});

test("agent key uses /v1/authorize and returns the receipt", async () => {
  const seen = [];
  const d = await checkPayment(PAY, { agentKey: "pc_agent_x", fetch: fakePayCheck({ outcome: "allow", reasons: ["all rules passed"], receipt: "r.s", decision: "dec_1" }, 200, seen) });
  assert.equal(d.allow, true); assert.equal(d.receipt, "r.s");
  assert.match(seen[0].url, /\/v1\/authorize$/); assert.equal(seen[0].init.headers.authorization, "Bearer pc_agent_x");
});

test("review is not an allow", async () => {
  const d = await checkPayment(PAY, { agentKey: "k", fetch: fakePayCheck({ outcome: "review", reasons: ["above review threshold"] }) });
  assert.equal(d.allow, false); assert.equal(d.outcome, "review");
});

test("PayCheck unreachable: blocked by default, allowed with failOpen", async () => {
  const boom = async () => { throw new Error("network down"); };
  assert.equal((await checkPayment(PAY, { fetch: boom })).allow, false);
  assert.equal((await checkPayment(PAY, { fetch: boom, failOpen: true })).allow, true);
});

test("HTTP error from PayCheck blocks by default", async () => {
  const d = await checkPayment(PAY, { fetch: fakePayCheck({ error: "rate_limited" }, 429) });
  assert.equal(d.allow, false); assert.equal(d.outcome, "error"); assert.match(d.reasons[0], /429/);
});

class FakeClient { hooks = []; onBeforePaymentCreation(h) { this.hooks.push(h); return this; } }
const ctx = (url) => ({ paymentRequired: { resource: url ? { url } : undefined, accepts: [] }, selectedRequirements: { amount: "10000", payTo: "0xabc", network: "eip155:8453" } });

test("withPayCheck aborts a denied payment and allows an approved one", async () => {
  const denyClient = withPayCheck(new FakeClient(), { fetch: fakePayCheck({ allow: false, reasons: ["verdict is avoid"] }) });
  const r1 = await denyClient.hooks[0](ctx("https://api.example.com/x"));
  assert.equal(r1.abort, true); assert.match(r1.reason, /verdict is avoid/);
  assert.equal(denyClient.lastPayCheckDecision.allow, false);
  const okClient = withPayCheck(new FakeClient(), { fetch: fakePayCheck({ allow: true, reasons: [] }) });
  assert.equal(await okClient.hooks[0](ctx("https://api.example.com/x")), undefined);
});

test("no resource URL: blocked unless wrapFetchWithPayCheck supplies the request URL", async () => {
  const seen = [];
  const client = new FakeClient();
  const r = await withPayCheck(new FakeClient(), { fetch: fakePayCheck({ allow: true }) }).hooks[0](ctx(null));
  assert.equal(r.abort, true);
  // wrapFetchWithPayCheck: the fake "wrapFetchWithPayment" calls the hook during the request, like the real one does
  const fakeWrap = (f, c) => async (input) => { const res = await c.hooks[0](ctx(null)); if (res?.abort) throw new Error(res.reason); return new Response("paid"); };
  const fetchWithPay = wrapFetchWithPayCheck(async () => new Response(""), client, fakeWrap, { fetch: fakePayCheck({ allow: true, reasons: [] }, 200, seen) });
  const res = await fetchWithPay("https://api.example.com/v1-endpoint");
  assert.equal(await res.text(), "paid");
  assert.equal(JSON.parse(seen[0].init.body).url, "https://api.example.com/v1-endpoint");
});

test("minOrganicShare is sent and buyers come back", async () => {
  const seen = [];
  const buyers = { reviewed: true, independentBuyers30d: 21, buyerWallets30d: 90, organicShare: 0.22, estimated: false, flags: ["coordinated_wallets"] };
  const d = await checkPayment(PAY, { fetch: fakePayCheck({ allow: false, reasons: ["only 22% of this seller's volume comes from independent buyers"], buyers }, 200, seen), rules: { minOrganicShare: 0.5 } });
  assert.equal(JSON.parse(seen[0].init.body).rules.minOrganicShare, 0.5);
  assert.equal(d.allow, false);
  assert.deepEqual(d.buyers, buyers);
});

const paidResponse = (status, tx) => new Response("{}", { status, headers: tx ? { "payment-response": Buffer.from(JSON.stringify({ success: true, transaction: tx, network: "eip155:8453" })).toString("base64") } : {} });

test("paymentTxFrom reads the settlement transaction from the paid response", () => {
  assert.equal(paymentTxFrom(paidResponse(200, "0xabc123")), "0xabc123");
  assert.equal(paymentTxFrom(paidResponse(200)), undefined);
});

test("reportOutcome sends url + tx + answers, filling gotResponse and status from the response", async () => {
  const seen = [];
  const r = await reportOutcome({ url: "https://api.example.com/x", response: paidResponse(200, "0x" + "1".repeat(64)), answers: { matchedListing: "yes", dataUsable: "yes", charged: "as_quoted" } },
    { fetch: fakePayCheck({ accepted: true, outcome: "delivered", ourTestQueued: true, verifiedOnChain: true }, 200, seen) });
  assert.equal(r.accepted, true); assert.equal(r.ourTestQueued, true); assert.equal(r.verifiedOnChain, true);
  assert.match(seen[0].url, /\/v1\/report$/);
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.tx, "0x" + "1".repeat(64)); assert.equal(body.url, "https://api.example.com/x");
  assert.equal(body.answers.gotResponse, true); assert.equal(body.answers.matchedListing, "yes"); assert.equal(body.httpStatus, 200);
});

test("reportOutcome with a receipt (team plans) sends the receipt, not the tx", async () => {
  const seen = [];
  await reportOutcome({ url: "https://api.example.com/x", receipt: "r.s", outcome: "problem", problems: ["HTTP 500"] }, { fetch: fakePayCheck({ accepted: true }, 200, seen) });
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.receipt, "r.s"); assert.equal(body.tx, undefined); assert.equal(body.outcome, "problem");
});

test("reportOutcome never throws: no proof, a refusal, or PayCheck down", async () => {
  assert.equal((await reportOutcome({ url: "https://api.example.com/x", response: paidResponse(200) })).accepted, false);
  const refused = await reportOutcome({ url: "u", tx: "0x1" }, { fetch: fakePayCheck({ accepted: false, reason: "transaction not found yet" }, 400) });
  assert.equal(refused.accepted, false); assert.match(refused.reason, /not found/);
  const down = await reportOutcome({ url: "u", tx: "0x1" }, { fetch: async () => { throw new Error("offline"); } });
  assert.equal(down.accepted, false); assert.match(down.reason, /offline/);
});

test("hasAccess is sent for listed sellers only, and authRequired comes back", async () => {
  const seen = [];
  const d = await checkPayment(PAY, { hasAccess: ["api.example.com"], fetch: fakePayCheck({ allow: true, reasons: [], authRequired: true }, 200, seen) });
  assert.equal(JSON.parse(seen[0].init.body).hasAccess, true); assert.equal(d.authRequired, true);
  await checkPayment(PAY, { hasAccess: ["other.example"], fetch: fakePayCheck({ allow: true }, 200, seen) });
  assert.equal(JSON.parse(seen[1].init.body).hasAccess, undefined);
  await checkPayment(PAY, { agentKey: "k", hasAccess: true, fetch: fakePayCheck({ outcome: "allow", reasons: [] }, 200, seen) });
  assert.equal(JSON.parse(seen[2].init.body).hasAccess, true);
});

// ---------------- v0.3: enforcement and agent credentials ----------------
test("agent key: fails closed when PayCheck is down, unless under the workspace's no-check amount", async () => {
  const key = "pc_agent_failopen";
  await checkPayment(PAY, { agentKey: key, fetch: fakePayCheck({ outcome: "allow", reasons: [], enforcement: { failClosed: true, failOpenUnder: "50000" } }) });
  const down = async () => { throw new Error("down"); };
  const small = await checkPayment({ ...PAY, amount: "10000" }, { agentKey: key, fetch: down });
  const big = await checkPayment({ ...PAY, amount: "90000" }, { agentKey: key, fetch: down });
  assert.equal(small.allow, true); assert.match(small.reasons[0], /no-check amount/);
  assert.equal(big.allow, false); assert.match(big.reasons[0], /fail closed/);
  assert.equal((await checkPayment(PAY, { agentKey: "pc_agent_other", fetch: down })).allow, false, "no remembered amount: closed");
  assert.equal((await checkPayment(PAY, { agentKey: key, failOpenUnder: "0", fetch: down })).allow, false, "explicit 0 overrides");
  const e500 = await checkPayment({ ...PAY, amount: "10000" }, { agentKey: key, fetch: fakePayCheck({ error: "internal_error" }, 500) });
  assert.equal(e500.allow, true, "a 5xx counts as unreachable");
  const e401 = await checkPayment({ ...PAY, amount: "10000" }, { agentKey: key, fetch: fakePayCheck({ error: "unauthorized" }, 401) });
  assert.equal(e401.allow, false, "a bad key never fails open");
});

test("agent key: waits for a person to approve a review when asked to", async () => {
  let polls = 0;
  const f = async (url) => {
    if (/\/v1\/authorize$/.test(url)) return new Response(JSON.stringify({ outcome: "review", reasons: ["first payment to a new wallet"], decision: "dec_9" }));
    polls++; return new Response(JSON.stringify(polls < 2 ? { final: "review" } : { final: "allow", receipt: "r.s", reasons: ["approved"] }));
  };
  const d = await checkPayment(PAY, { agentKey: "k2", fetch: f, reviewWaitMs: 8000 });
  assert.equal(d.allow, true); assert.equal(d.receipt, "r.s"); assert.equal(polls, 2);
});

test("consumeReceipt marks a receipt used", async () => {
  const seen = [];
  const r = await consumeReceipt("a.b", { fetch: fakePayCheck({ valid: false, reason: "already used: a receipt approves one payment" }, 200, seen) });
  assert.equal(r.valid, false); assert.match(r.reason, /already used/);
  assert.equal(JSON.parse(seen[0].init.body).consume, true);
});

test("agent credentials: fetched once per seller and sent as X-PayCheck-Agent", async () => {
  let issued = 0; const sent = [];
  const pc = async (url) => { issued++; return new Response(JSON.stringify({ credential: "h.p.s", expiresAt: new Date(Date.now() + 900_000).toISOString(), audience: "api.example.com", agentId: "agt_x", level: "domain", named: true })); };
  const a = await getAgentCredential("https://api.example.com/v1", { agentKey: "pc_agent_c", fetch: pc });
  const b = await getAgentCredential("api.example.com", { agentKey: "pc_agent_c", fetch: pc });
  assert.equal(a.credential, "h.p.s"); assert.equal(b.credential, "h.p.s"); assert.equal(issued, 1);
  const client = { onBeforePaymentCreation() {} };
  const wrap = (f) => async (input, init) => f(input, init);
  const realFetch = globalThis.fetch;
  globalThis.fetch = pc;
  try {
    const paid = wrapFetchWithPayCheck(async (input, init) => { sent.push(new Headers(init?.headers).get("x-paycheck-agent")); return new Response("ok"); }, client, wrap, { agentKey: "pc_agent_c", agentCredential: true });
    await paid("https://api.example.com/v1/data");
  } finally { globalThis.fetch = realFetch; }
  assert.equal(sent[0], "h.p.s");
});

test("verifyAgentCredential: signature, audience, paying wallet, live status", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "paycheck-agents-1", alg: "EdDSA" };
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const make = (claims) => { const h = b({ alg: "EdDSA", typ: "JWT", kid: "paycheck-agents-1" }), p = b(claims); return `${h}.${p}.${sign(null, Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`; };
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: "https://lumierepaycheck.org", sub: "agt_1", aud: "api.example.com", iat: now, exp: now + 900, jti: "cred_1", pc: { v: 1, level: "domain", wallets: [{ network: "base", address: "0xAbC" }], org: { name: "Acme", domains: ["acme.test"] } } };
  let active = true;
  const f = async (url) => new Response(JSON.stringify(/jwks/.test(url) ? { keys: [jwk] } : { active, reason: active ? undefined : "revoked: the company turned agent credentials off" }));
  const ok = await verifyAgentCredential(make(claims), { audience: "https://api.example.com/x", payer: "0xabc", fetch: f });
  assert.equal(ok.valid, true); assert.equal(ok.org.name, "Acme"); assert.equal(ok.level, "domain");
  assert.match((await verifyAgentCredential(make(claims), { audience: "evil.example", fetch: f })).reason, /issued for/);
  assert.match((await verifyAgentCredential(make(claims), { audience: "api.example.com", payer: "0xdef", fetch: f })).reason, /paying wallet/);
  assert.equal((await verifyAgentCredential(make({ ...claims, exp: now - 120 }), { audience: "api.example.com", fetch: f })).reason, "expired");
  const t = make(claims); assert.equal((await verifyAgentCredential(t.slice(0, -4) + "AAAA", { audience: "api.example.com", fetch: f })).reason, "bad signature");
  active = false; assert.match((await verifyAgentCredential(make(claims), { audience: "api.example.com", fetch: f })).reason, /turned agent credentials off/);
  assert.equal((await verifyAgentCredential(undefined, { audience: "x" })).valid, false);
});
