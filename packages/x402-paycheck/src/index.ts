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

import { AsyncLocalStorage } from "node:async_hooks";

export const DEFAULT_API = "https://lumierepaycheck.org";

export interface PayCheckRules {
  maxAmount?: string | number;      // atomic units (USDC: 1000000 = $1)
  allowCaution?: boolean;           // default true
  requireVerified?: boolean;        // default false: require a passed paid delivery check
  requireMonitored?: boolean;       // default true: endpoints PayCheck doesn't monitor are blocked
  pinPayTo?: boolean;               // default true: payTo must match the monitored wallet
  allowUnconfirmedWallet?: boolean; // default false
}

export interface PayCheckOptions {
  apiUrl?: string;                  // default https://lumierepaycheck.org
  apiKey?: string;                  // free API key (higher rate limit), sent as x-paycheck-key
  agentKey?: string;                // team plan agent key: uses /v1/authorize (spend limits, receipts)
  rules?: PayCheckRules;            // rules for the free check (ignored with agentKey: the workspace's rules apply)
  failOpen?: boolean;               // default false: if PayCheck can't be reached, block the payment
  timeoutMs?: number;               // default 8000
  onDecision?: (d: PayCheckDecision) => void | Promise<void>;
  fetch?: typeof globalThis.fetch;  // the fetch used to call PayCheck (default: globalThis.fetch)
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
  decision?: string;                // decision id (agentKey only)
  raw?: unknown;
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
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "x402-paycheck/0.1" };
  let path = "/v1/check-payment", body: unknown;
  if (opts.agentKey) { path = "/v1/authorize"; headers.authorization = `Bearer ${opts.agentKey}`; body = { url: p.url, amount: String(p.amount), payTo: p.payTo, network: p.network }; }
  else { if (opts.apiKey) headers["x-paycheck-key"] = opts.apiKey; body = { url: p.url, amount: String(p.amount), payTo: p.payTo, network: p.network, ...(opts.rules ? { rules: opts.rules } : {}) }; }
  let decision: PayCheckDecision;
  try {
    const res = await f(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
    const j = await res.json().catch(() => ({})) as any;
    if (!res.ok) {
      decision = { allow: !!opts.failOpen, outcome: "error", reasons: [`PayCheck answered HTTP ${res.status}${j?.error ? `: ${j.error}` : ""}${opts.failOpen ? " (failOpen: allowed)" : ""}`], payment: p, raw: j };
    } else if (opts.agentKey) {
      const outcome = j.outcome === "allow" || j.outcome === "deny" || j.outcome === "review" ? j.outcome : "error";
      decision = { allow: outcome === "allow", outcome, reasons: Array.isArray(j.reasons) ? j.reasons : [], payment: p, receipt: j.receipt ?? undefined, decision: j.decision, raw: j };
    } else {
      decision = { allow: j.allow === true, outcome: j.allow === true ? "allow" : "deny", reasons: Array.isArray(j.reasons) ? j.reasons : [], payment: p, raw: j };
    }
  } catch (err) {
    decision = { allow: !!opts.failOpen, outcome: "error", reasons: [`couldn't reach PayCheck: ${(err as Error)?.message ?? err}${opts.failOpen ? " (failOpen: allowed)" : ""}`], payment: p };
  }
  try { await opts.onDecision?.(decision); } catch { /* callbacks never change the decision */ }
  return decision;
}

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
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    return currentUrl.run(url, () => paying(input, init));
  };
}
