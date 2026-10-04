import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPayment, withPayCheck, wrapFetchWithPayCheck } from "../dist/index.js";

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
