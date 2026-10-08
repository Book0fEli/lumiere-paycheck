// x402-paycheck: check every x402 payment with Lumière PayCheck before your agent pays.
//
//   import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
//   import { withPayCheck } from "x402-paycheck";
//
//   const client = withPayCheck(new x402Client().register("eip155:8453", new ExactEvmScheme(signer)));
//   const fetchWithPay = wrapFetchWithPayment(fetch, client);
//
// Before the x402 client signs a payment, PayCheck checks the endpoint's trust grade, that the
// price isn't higher than monitored, that the payout wallet hasn't been swapped (possible hijack),
// and OFAC sanctions on the wallet. If PayCheck says no, the payment is never created.
//
// With a team plan, pass `agentKey` to use /v1/authorize instead: per-agent spend limits,
// allowed sellers, human review, and a signed receipt for every allowed payment.
//
// Enforcement (team plans): with an agent key, a payment PayCheck denies can't be signed. If PayCheck can't be
// reached, the payment is blocked (fail closed) unless it's under the amount your workspace allows without a check
// (set on the account page; we remember the last value PayCheck sent). Reviews can be waited for (reviewWaitMs).
//
// Agent credentials (opt-in, team plans): agentCredential: true adds a short-lived X-PayCheck-Agent header to each
// paid request, so sellers can recognize your agent as belonging to a verified company. Sellers verify it with
// verifyAgentCredential().
//
// After paying, reportOutcome({ url, response }) tells PayCheck whether you got what you paid for (free,
// verified on-chain from the payment's transaction). Confirmations move the endpoint up PayCheck's own
// paid-test queue; problems trigger a re-test. Reports never change a grade by themselves.

import { AsyncLocalStorage } from "node:async_hooks";

export const DEFAULT_API = "https://lumierepaycheck.org";
const VERSION = "0.3.0";

export interface PayCheckRules {
  maxAmount?: string | number;      // atomic units (USDC: 1000000 = $1)
  allowCaution?: boolean;           // default true
  requireVerified?: boolean;        // default false: require a passed paid delivery check
  requireMonitored?: boolean;       // default true: endpoints PayCheck doesn't monitor are blocked
  pinPayTo?: boolean;               // default true: payTo must match the monitored wallet
  allowUnconfirmedWallet?: boolean; // default false
  minOrganicShare?: number;         // optional 0-1: least share of the seller's volume from independent buyers
}

export interface PayCheckOptions {
  apiUrl?: string;                  // default https://lumierepaycheck.org
  apiKey?: string;                  // free API key (higher rate limit), sent as x-paycheck-key
  agentKey?: string;                // team plan agent key: uses /v1/authorize (spend limits, receipts)
  rules?: PayCheckRules;            // rules for the free check (ignored with agentKey: the workspace's rules apply)
  failOpen?: boolean;               // default false: if PayCheck can't be reached, block the payment
  // Agent key only: if PayCheck can't be reached, allow payments under this amount (atomic units). Defaults to the
  // amount your workspace set (sent with every decision); set "0" to always fail closed.
  failOpenUnder?: string;
  reviewWaitMs?: number;            // agent key only: wait this long for a person to approve a "review" (default 0: don't wait)
  agentCredential?: boolean;        // agent key only: send an X-PayCheck-Agent credential with paid requests (wrapFetchWithPayCheck)
  timeoutMs?: number;               // default 8000
  onDecision?: (d: PayCheckDecision) => void | Promise<void>;
  fetch?: typeof globalThis.fetch;  // the fetch used to call PayCheck (default: globalThis.fetch)
  // You have your own account / API key / sign-in with these sellers (true for all, or a list of hostnames).
  // Endpoints that need the seller's own sign-in on top of x402 then aren't blocked by caution/verified rules.
  hasAccess?: boolean | string[];
}

export interface PaymentToCheck {
  url: string;                      // the x402 endpoint being paid
  amount: string;                   // atomic units from the 402 quote
  payTo: string;                    // payout wallet from the 402 quote
  network?: string;                 // e.g. eip155:8453 or solana:...
}

export interface PayCheckDecision {
  allow: boolean;
  outcome: "allow" | "deny" | "review" | "error";
  reasons: string[];
  payment: PaymentToCheck;
  receipt?: string;                 // signed receipt (agentKey only)
  buyers?: BuyerSummary;            // who is really behind the seller's buyers (free check only)
  decision?: string;                // decision id (agentKey only)
  authRequired?: boolean;           // the seller needs its own sign-in on top of x402 (see hasAccess)
  raw?: unknown;
}

// "We count customers, not wallets": buyer wallets funded from one source count as one buyer.
export interface BuyerSummary {
  reviewed: boolean;                // false until the seller's buyers have been reviewed
  independentBuyers30d?: number;
  buyerWallets30d?: number;
  organicShare?: number;            // 0-1 share of 30-day volume from independent buyers
  estimated?: boolean;
  flags?: string[];
}

export class PayCheckBlockedError extends Error {
  constructor(public decision: PayCheckDecision) {
    super(`Lumière PayCheck blocked this payment (${decision.outcome}): ${decision.reasons.join("; ") || "no reason given"}`);
    this.name = "PayCheckBlockedError";
  }
}

// Asks PayCheck whether a specific payment should go through. Never throws for a "no":
// returns { allow: false, ... }. Throws only on bad input.
export async function checkPayment(p: PaymentToCheck, opts: PayCheckOptions = {}): Promise<PayCheckDecision> {
  if (!p.url || !p.payTo || !/^\d+$/.test(String(p.amount))) throw new Error("checkPayment needs url, payTo, and amount (atomic units)");
  const base = (opts.apiUrl ?? DEFAULT_API).replace(/\/$/, "");
  const f = opts.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": `x402-paycheck/${VERSION}` };
  let host = ""; try { host = new URL(p.url).hostname.toLowerCase(); } catch { /* checked by PayCheck */ }
  const hasAccess = opts.hasAccess === true || (Array.isArray(opts.hasAccess) && opts.hasAccess.some(h => h.toLowerCase() === host));
  let path = "/v1/check-payment", body: unknown;
  if (opts.agentKey) { path = "/v1/authorize"; headers.authorization = `Bearer ${opts.agentKey}`; body = { url: p.url, amount: String(p.amount), payTo: p.payTo, network: p.network, ...(hasAccess ? { hasAccess: true } : {}) }; }
  else { if (opts.apiKey) headers["x-paycheck-key"] = opts.apiKey; body = { url: p.url, amount: String(p.amount), payTo: p.payTo, network: p.network, ...(hasAccess ? { hasAccess: true } : {}), ...(opts.rules ? { rules: opts.rules } : {}) }; }
  let decision: PayCheckDecision;
  const failSoft = (why: string): PayCheckDecision => {
    const under = opts.agentKey ? (opts.failOpenUnder ?? workspaceFailOpen.get(opts.agentKey) ?? null) : null;
    const small = !!under && under !== "0" && BigInt(String(p.amount)) < BigInt(under);
    const allow = !!opts.failOpen || small;
    return { allow, outcome: "error", reasons: [why + (opts.failOpen ? " (failOpen: allowed)" : small ? ` (under your workspace's no-check amount ${under}: allowed)` : " (fail closed: not paid)")], payment: p };
  };
  try {
    const res = await f(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
    const j = await res.json().catch(() => ({})) as any;
    if (!res.ok) {
      decision = res.status >= 500 || res.status === 429 ? { ...failSoft(`PayCheck answered HTTP ${res.status}${j?.error ? `: ${j.error}` : ""}`), raw: j }
        : { allow: !!opts.failOpen, outcome: "error", reasons: [`PayCheck answered HTTP ${res.status}${j?.error ? `: ${j.error}` : ""}${j?.detail ? ` (${j.detail})` : ""}${opts.failOpen ? " (failOpen: allowed)" : ""}`], payment: p, raw: j };
    } else if (opts.agentKey) {
      if (j?.enforcement && "failOpenUnder" in j.enforcement) workspaceFailOpen.set(opts.agentKey, j.enforcement.failOpenUnder ?? "0");
      let outcome = j.outcome === "allow" || j.outcome === "deny" || j.outcome === "review" ? j.outcome : "error";
      if (outcome === "review" && opts.reviewWaitMs && j.decision) {
        const until = Date.now() + opts.reviewWaitMs;
        while (Date.now() < until) {
          await new Promise(r => setTimeout(r, Math.min(3000, Math.max(0, until - Date.now()))));
          try {
            const pr = await f(`${base}/v1/decisions/${encodeURIComponent(j.decision)}`, { headers: { authorization: `Bearer ${opts.agentKey}`, "user-agent": `x402-paycheck/${VERSION}` }, signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
            const pj = await pr.json().catch(() => ({})) as any;
            if (pj.final === "allow" || pj.final === "deny" || pj.final === "expired") { outcome = pj.final === "allow" ? "allow" : "deny"; j.receipt = pj.receipt ?? j.receipt; j.reasons = pj.reasons ?? j.reasons; break; }
          } catch { /* keep waiting */ }
        }
      }
      decision = { allow: outcome === "allow", outcome, reasons: Array.isArray(j.reasons) ? j.reasons : [], payment: p, receipt: j.receipt ?? undefined, decision: j.decision,
                   ...(j.authRequired ? { authRequired: true } : {}), raw: j };
    } else {
      decision = { allow: j.allow === true, outcome: j.allow === true ? "allow" : "deny", reasons: Array.isArray(j.reasons) ? j.reasons : [], payment: p,
                   ...(j.buyers && typeof j.buyers === "object" ? { buyers: j.buyers as BuyerSummary } : {}), ...(j.authRequired ? { authRequired: true } : {}), raw: j };
    }
  } catch (err) {
    decision = failSoft(`couldn't reach PayCheck: ${(err as Error)?.message ?? err}`);
  }
  try { await opts.onDecision?.(decision); } catch { /* callbacks never change the decision */ }
  return decision;
}

// The workspace's "allow without a check under $X" amount, remembered per agent key from the last decision.
const workspaceFailOpen = new Map<string, string>();

// The URL of the request being paid, for 402 quotes that don't include resource.url (x402 v1).
const currentUrl = new AsyncLocalStorage<string>();

// Minimal shape of x402Client we rely on (from @x402/fetch / @x402/core): the before-payment hook.
interface HookableClient {
  onBeforePaymentCreation(hook: (ctx: { paymentRequired: { resource?: { url?: string } }; selectedRequirements: { amount: string; payTo: string; network: string } }) =>
    Promise<void | { abort: true; reason: string }>): unknown;
}

// Adds PayCheck to an x402Client: every payment is checked before it's created; a "no" aborts it.
// Also records the last decision on `lastPayCheckDecision` for logging.
export function withPayCheck<C extends HookableClient>(client: C, opts: PayCheckOptions = {}): C & { lastPayCheckDecision?: PayCheckDecision } {
  const c = client as C & { lastPayCheckDecision?: PayCheckDecision };
  client.onBeforePaymentCreation(async (ctx) => {
    const url = ctx.paymentRequired?.resource?.url || currentUrl.getStore();
    if (!url) return { abort: true, reason: "Lumière PayCheck: the 402 quote has no resource URL; use wrapFetchWithPayCheck so the request URL is known" };
    const r = ctx.selectedRequirements;
    const d = await checkPayment({ url, amount: String(r.amount), payTo: r.payTo, network: r.network }, opts);
    c.lastPayCheckDecision = d;
    if (!d.allow) return { abort: true, reason: `Lumière PayCheck: ${d.outcome}: ${d.reasons.join("; ") || "not allowed"}` };
  });
  return c;
}

// One step: wraps fetch with x402 payments, checked by PayCheck. Pass an x402Client (from @x402/fetch)
// and the wrapFetchWithPayment function, so this package never pins its own copy of the x402 client.
export function wrapFetchWithPayCheck(
  fetchFn: typeof globalThis.fetch,
  client: HookableClient,
  wrapFetchWithPayment: (f: typeof globalThis.fetch, c: any) => (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  opts: PayCheckOptions = {},
) {
  const paying = wrapFetchWithPayment(fetchFn, withPayCheck(client, opts));
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (opts.agentCredential && opts.agentKey) {
      const c = await getAgentCredential(new URL(url).host, opts).catch(() => null);
      if (c?.credential) { const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)); h.set("x-paycheck-agent", c.credential); init = { ...init, headers: h }; }
    }
    return currentUrl.run(url, () => paying(input, init));
  };
}

// ---------------- after paying: report how it went ----------------

export interface ReportAnswers {
  gotResponse?: boolean;                         // did you get a response after paying?
  matchedListing?: "yes" | "partly" | "no";      // did it match what the listing promised?
  charged?: "as_quoted" | "more" | "twice";      // were you charged the quoted amount, once?
  dataUsable?: "yes" | "unsure" | "no";          // did the data look real and usable?
  wouldPayAgain?: boolean;
}

export interface OutcomeReport {
  url: string;                      // the endpoint you paid
  response?: Response;              // the paid response: tx, HTTP status and gotResponse are read from it
  tx?: string;                      // payment transaction (Base hash or Solana signature), if not read from response
  receipt?: string;                 // team plans: the receipt from the allow decision (instead of tx)
  answers?: ReportAnswers;
  outcome?: "delivered" | "problem"; // optional shortcut instead of answers
  problems?: string[];              // short descriptions, e.g. "missing field price"
  httpStatus?: number;
}

export interface ReportResult {
  accepted: boolean;
  reason?: string;                  // why it wasn't accepted (e.g. transaction not found yet)
  outcome?: "delivered" | "problem";
  ourTestQueued?: boolean;          // PayCheck's own paid test of this endpoint is queued
  retestQueued?: boolean;
  flagged?: string;                 // no_response, overcharged or double_charged
  verifiedOnChain?: boolean;
  raw?: unknown;
}

// Reads the settlement transaction from an x402 paid response (PAYMENT-RESPONSE / X-PAYMENT-RESPONSE header).
export function paymentTxFrom(res: Response | undefined | null): string | undefined {
  const h = res?.headers?.get("payment-response") ?? res?.headers?.get("x-payment-response");
  if (!h) return undefined;
  for (const decode of [(s: string) => Buffer.from(s, "base64").toString("utf8"), (s: string) => s]) {
    try { const j = JSON.parse(decode(h.trim())); const tx = j?.transaction ?? j?.txHash ?? j?.tx; if (typeof tx === "string" && tx) return tx; } catch { /* try next */ }
  }
  return undefined;
}

// Tells PayCheck whether a paid call delivered. Free and optional. With `response`, the transaction, status
// and whether a response came back are filled in for you; add `answers` for the rest. Never throws.
export async function reportOutcome(r: OutcomeReport, opts: Pick<PayCheckOptions, "apiUrl" | "apiKey" | "timeoutMs" | "fetch"> = {}): Promise<ReportResult> {
  const base = (opts.apiUrl ?? DEFAULT_API).replace(/\/$/, "");
  const f = opts.fetch ?? globalThis.fetch;
  const tx = r.tx ?? paymentTxFrom(r.response);
  if (!r.receipt && !tx) return { accepted: false, reason: "no receipt and no payment transaction: pass receipt, tx, or the paid response (with its payment-response header)" };
  const status = r.httpStatus ?? r.response?.status;
  const answers: ReportAnswers = { ...(r.response ? { gotResponse: r.response.ok } : {}), ...(r.answers ?? {}) };
  const body = { ...(r.receipt ? { receipt: r.receipt } : { url: r.url, tx }), ...(Object.keys(answers).length ? { answers } : {}),
                 ...(r.outcome ? { outcome: r.outcome } : {}), ...(r.problems?.length ? { problems: r.problems } : {}), ...(status ? { httpStatus: status } : {}) };
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": `x402-paycheck/${VERSION}` };
  if (opts.apiKey) headers["x-paycheck-key"] = opts.apiKey;
  try {
    const res = await f(`${base}/v1/report`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
    const j = await res.json().catch(() => ({})) as any;
    return { accepted: j.accepted === true, ...(j.reason ? { reason: j.reason } : {}), ...(j.outcome ? { outcome: j.outcome } : {}),
             ...(typeof j.ourTestQueued === "boolean" ? { ourTestQueued: j.ourTestQueued } : {}), ...(typeof j.retestQueued === "boolean" ? { retestQueued: j.retestQueued } : {}),
             ...(j.flagged ? { flagged: j.flagged } : {}), ...(j.verifiedOnChain ? { verifiedOnChain: true } : {}), raw: j };
  } catch (err) {
    return { accepted: false, reason: `couldn't reach PayCheck: ${(err as Error)?.message ?? err}` };
  }
}

// ---------------- enforcement helpers ----------------

// For wallet code that requires a receipt: checks it with PayCheck and marks it used, so it approves one payment.
export async function consumeReceipt(receipt: string, opts: Pick<PayCheckOptions, "apiUrl" | "timeoutMs" | "fetch"> = {}): Promise<{ valid: boolean; reason?: string; payload?: any }> {
  const f = opts.fetch ?? globalThis.fetch, base = (opts.apiUrl ?? DEFAULT_API).replace(/\/$/, "");
  try {
    const r = await f(`${base}/v1/receipts/verify`, { method: "POST", headers: { "content-type": "application/json", "user-agent": `x402-paycheck/${VERSION}` }, body: JSON.stringify({ receipt, consume: true }), signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
    const j = await r.json().catch(() => ({})) as any;
    return { valid: j.valid === true, ...(j.reason ? { reason: j.reason } : {}), ...(j.payload ? { payload: j.payload } : {}) };
  } catch (err) { return { valid: false, reason: `couldn't reach PayCheck: ${(err as Error)?.message ?? err}` }; }
}

// ---------------- agent credentials ----------------

export interface AgentCredential { credential: string; expiresAt: string; audience: string; agentId: string; level: string; named: boolean }
const credCache = new Map<string, AgentCredential>();

// Agent side: a short-lived credential for one seller (cached until a minute before it expires).
export async function getAgentCredential(audience: string, opts: Pick<PayCheckOptions, "apiUrl" | "agentKey" | "timeoutMs" | "fetch">): Promise<AgentCredential> {
  if (!opts.agentKey) throw new Error("getAgentCredential needs agentKey");
  const aud = audience.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const k = `${opts.agentKey.slice(-12)}|${aud}`, hit = credCache.get(k);
  if (hit && Date.parse(hit.expiresAt) - Date.now() > 60_000) return hit;
  const f = opts.fetch ?? globalThis.fetch, base = (opts.apiUrl ?? DEFAULT_API).replace(/\/$/, "");
  const r = await f(`${base}/v1/agents/credential`, { method: "POST", headers: { authorization: `Bearer ${opts.agentKey}`, "content-type": "application/json", "user-agent": `x402-paycheck/${VERSION}` },
    body: JSON.stringify({ audience: aud }), signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
  const j = await r.json().catch(() => ({})) as any;
  if (!r.ok || !j.credential) throw new Error(`no agent credential: ${j.detail ?? j.error ?? r.status}`);
  const c: AgentCredential = { credential: j.credential, expiresAt: j.expiresAt, audience: j.audience, agentId: j.agentId, level: j.level, named: !!j.named };
  credCache.set(k, c);
  return c;
}

export interface VerifiedAgent { valid: boolean; reason?: string; agent?: string; level?: "workspace" | "domain" | "business"; org?: { name: string; domains: string[] } | null; wallets?: { network: string; address: string }[]; expiresAt?: string }
const jwksCache = new Map<string, { keys: any[]; at: number }>();

// Seller side: is this X-PayCheck-Agent credential real, for me, from the wallet that paid, and still active?
//   audience  your host (e.g. "api.example.com"); required
//   payer     the wallet that paid you (from the x402 payment), so a stolen credential is useless from another wallet
//   online    also ask PayCheck whether it was revoked in the last 15 minutes (default true)
export async function verifyAgentCredential(token: string | null | undefined, o: { audience: string; payer?: string; online?: boolean; apiUrl?: string; fetch?: typeof globalThis.fetch; timeoutMs?: number }): Promise<VerifiedAgent> {
  if (!token || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return { valid: false, reason: "no credential" };
  const { createPublicKey, verify } = await import("node:crypto");
  const f = o.fetch ?? globalThis.fetch, base = (o.apiUrl ?? DEFAULT_API).replace(/\/$/, "");
  const [h, p, s] = token.split(".");
  let header: any, claims: any;
  try { header = JSON.parse(Buffer.from(h, "base64url").toString()); claims = JSON.parse(Buffer.from(p, "base64url").toString()); } catch { return { valid: false, reason: "malformed credential" }; }
  if (header.alg !== "EdDSA") return { valid: false, reason: "unexpected algorithm" };
  let keys = jwksCache.get(base);
  if (!keys || Date.now() - keys.at > 3600_000 || !keys.keys.some(k => k.kid === header.kid)) {
    const r = await f(`${base}/.well-known/jwks.json`, { signal: AbortSignal.timeout(o.timeoutMs ?? 8000) });
    keys = { keys: ((await r.json()) as any).keys ?? [], at: Date.now() }; jwksCache.set(base, keys);
  }
  const jwk = keys.keys.find(k => k.kid === header.kid && k.kid === "paycheck-agents-1");
  if (!jwk) return { valid: false, reason: "unknown signing key" };
  if (!verify(null, Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"))) return { valid: false, reason: "bad signature" };
  if (claims.iss !== base) return { valid: false, reason: "issued by someone else" };
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now() - 30_000) return { valid: false, reason: "expired" };
  const aud = o.audience.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (claims.aud !== aud) return { valid: false, reason: `issued for ${claims.aud}, not ${aud}` };
  const norm = (a: string) => (a.startsWith("0x") ? a.toLowerCase() : a);
  if (o.payer && !(claims.pc?.wallets ?? []).some((w: any) => norm(String(w.address)) === norm(o.payer!))) return { valid: false, reason: "the paying wallet isn't this agent's" };
  if (o.online !== false) {
    try {
      const r = await f(`${base}/v1/credentials/status/${encodeURIComponent(claims.jti)}`, { signal: AbortSignal.timeout(o.timeoutMs ?? 8000) });
      const st = await r.json() as any;
      if (!st.active) return { valid: false, reason: st.reason ?? "revoked" };
    } catch { return { valid: false, reason: "couldn't check the credential's status" }; }
  }
  return { valid: true, agent: claims.sub, level: claims.pc?.level, org: claims.pc?.org ?? null, wallets: claims.pc?.wallets ?? [], expiresAt: new Date(claims.exp * 1000).toISOString() };
}
