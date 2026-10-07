#!/usr/bin/env node
// Lumière PayCheck MCP server (stdio).
// Runs locally and answers with data from the public Lumière PayCheck API (https://lumierepaycheck.org), so an agent can
// check an x402 endpoint, or a specific payment, before paying it. Free; no API key needed.
// The same tools are also served remotely at https://lumierepaycheck.org/mcp (Streamable HTTP).
//   LUMIERE_PAYCHECK_URL  optional, API base URL (default https://lumierepaycheck.org)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API = (process.env.LUMIERE_PAYCHECK_URL || "https://lumierepaycheck.org").replace(/\/+$/, "");
const VERSION = "1.1.0";
const D = {
  "check_endpoint": "Get the trust verdict for one x402 endpoint: score (0-100), grade (A-F), and verdict (proceed, caution, avoid, free, or insufficient_data), plus uptime, delivery-test status, payout-wallet incidents, and how many independent buyers stand behind the seller's buyer wallets (we count customers, not wallets). Use it when you're deciding whether an endpoint is trustworthy at all, before you have a price quote. When you already have the 402 quote (amount and payTo) and are about to pay, use check_payment instead: it runs this same check and also verifies the price and wallet. To discover good endpoints rather than check a known one, use top_endpoints. Read-only and free; reflects monitoring every 30 minutes and real test payments, so a brand-new endpoint may return insufficient_data. Endpoints not in the catalog return monitored: false. API docs: https://github.com/Book0fEli/lumiere-paycheck/blob/main/docs/api.md",
  "check_payment": "Decide whether a specific x402 payment should go through: returns allow true/false with reasons. Checks the endpoint's trust verdict, that the amount is within your cap and not above the monitored price, and that the payTo wallet matches the one we've observed (catches swapped or hijacked wallets). Optionally (minOrganicShare) it also requires that enough of the seller's volume comes from independent buyers. Intended for right before a payment, with the amount, payTo, and network from the endpoint's 402 quote; allow is true only when every rule passes. Use check_endpoint instead if you only want an endpoint's grade without a quote in hand. Read-only and free; it doesn't make or block the payment itself. When allow is false, the reasons list explains why. API docs: https://github.com/Book0fEli/lumiere-paycheck/blob/main/docs/api.md",
  "report_outcome": "After paying an x402 endpoint, report whether you got what you paid for. Free, optional, and open to every agent: send the receipt from a Lumière PayCheck allow decision (paid plans), or the endpoint url plus the payment's transaction hash (anyone; we verify the payment on-chain, Base or Solana, within 24 hours). Answer the short questions in answers: gotResponse, matchedListing (yes/partly/no), charged (as_quoted/more/twice), dataUsable (yes/unsure/no), wouldPayAgain. Reports never change a grade by themselves: confirmations from independent buyers move the endpoint up our paid-test queue, and serious problems (nothing came back, charged more or twice) trigger a re-test; only our own paid test changes the grade. One report per payment; the seller's own wallet can't report on itself.",
  "top_endpoints": "List the x402 endpoints that are currently safest to pay (verdict proceed or caution, no payout-wallet incidents), best first, with score, grade, verdict, and whether a real test payment was delivered. Use it to discover reliable endpoints or pick between providers. To evaluate one specific endpoint use check_endpoint; to approve a payment use check_payment. Read-only and free; rankings update as monitoring runs (every 30 minutes).",
  "catalog_stats": "Get an overview of the whole monitored x402 catalog: how many endpoints are monitored, how many fall into each verdict (proceed, caution, avoid, free, insufficient_data), and when scores were last computed. Use it for context or reporting, for example to tell a user how much of the x402 ecosystem passes checks. It says nothing about any single endpoint: use check_endpoint for one endpoint, top_endpoints for a ranked list, or check_payment before paying. Read-only, free, no parameters.",
  "get_full_report": "Get instructions for buying the detailed paid report on one x402 endpoint (score breakdown, current price quote, wallet and price history, test-payment results). Returns the report URL, price, and network; it doesn't buy the report itself. The report is an x402 endpoint that your agent pays with any x402 client. Use it only when the free check_endpoint result isn't enough and the user wants the full history. The response also lists the other paid x402 checks (wallet risk, batch grades, watch alerts), paid the same way. Endpoints we don't monitor return 404 on the report URL and are never charged. API docs: https://github.com/Book0fEli/lumiere-paycheck/blob/main/docs/api.md"
};

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { accept: "application/json", "user-agent": `lumiere-paycheck-mcp/${VERSION}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return { status: 0, data: { error: "unreachable", detail: `Couldn't reach ${API}: ${e?.message ?? e}` } };
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: "bad_response", status: res.status, body: text.slice(0, 500) }; }
  return { status: res.status, data };
}

const out = (data, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], ...(isError ? { isError: true } : {}) });
const page = (url) => `${API}/e?url=${encodeURIComponent(url)}`;
const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const server = new McpServer({ name: "lumiere-paycheck", title: "Lumière PayCheck", version: VERSION, websiteUrl: "https://lumierepaycheck.org" }, {
  instructions: "Lumière PayCheck checks x402 endpoints before an agent pays them. Call check_endpoint for a trust verdict, or check_payment with the amount and payTo from the 402 quote before paying; check_payment returns allow true only when every rule passes. After paying, report_outcome records whether you got what you paid for (with a receipt, or the payment tx). Free to use.",
});

server.registerTool("check_endpoint", {
  title: "Check an x402 endpoint",
  description: D.check_endpoint,
  inputSchema: { url: z.string().describe("Full URL of the x402 endpoint including path, exactly as the agent will call it, e.g. https://api.example.com/v1/price.") },
  annotations: { ...ro, title: "Check an x402 endpoint" },
}, async ({ url }) => {
  const r = await call("GET", `/v1/score?url=${encodeURIComponent(url)}`);
  if (r.status === 404) return out({ url, monitored: false, verdict: "insufficient_data", advice: "Not in the monitored catalog. Treat as unverified; endpoints listed in the x402 Bazaar are added automatically." });
  if (r.status !== 200) return out(r.data, true);
  return out({ monitored: true, ...r.data, page: r.data.page ?? page(r.data.url ?? url) });
});

server.registerTool("check_payment", {
  title: "Check an x402 payment before paying",
  description: D.check_payment,
  inputSchema: {
    url: z.string().describe("Full URL of the x402 endpoint you are about to pay, including path"),
    amount: z.string().optional().describe("Amount about to be paid, atomic units (USDC has 6 decimals: 10000 = $0.01)"),
    payTo: z.string().optional().describe("Wallet address from the endpoint's 402 quote"),
    network: z.string().optional().describe("Network from the quote, e.g. eip155:8453"),
    maxAmount: z.string().optional().describe("Your hard cap for this payment in atomic units (USDC: 1000000 = $1). Payments above it are denied."),
    requireVerified: z.boolean().optional().describe("true = only allow endpoints that delivered on a real test payment (default false)"),
    allowCaution: z.boolean().optional().describe("false = deny endpoints with a caution verdict too, not just avoid (default true)"),
    minOrganicShare: z.number().min(0).max(1).optional().describe("Optional, 0-1: deny sellers where less than this share of 30-day volume comes from independent buyers (e.g. 0.5). Not applied to sellers whose buyers haven't been reviewed yet."),
    hasAccess: z.boolean().optional().describe("true if you have your own account, API key or sign-in with this seller. For endpoints that need the seller's sign-in on top of x402, allowCaution/requireVerified then don't block (we couldn't confirm delivery only because we can't sign in)."),
  },
  annotations: { ...ro, title: "Check an x402 payment before paying" },
}, async (a) => {
  const rules = {};
  for (const k of ["maxAmount", "requireVerified", "allowCaution", "minOrganicShare"]) if (a[k] !== undefined) rules[k] = a[k];
  const body = { url: a.url, amount: a.amount, payTo: a.payTo, network: a.network, ...(a.hasAccess ? { hasAccess: true } : {}), rules };
  const r = await call("POST", "/v1/check-payment", body);
  return out(r.data, r.status !== 200);
});

server.registerTool("report_outcome", {
  title: "Report how a paid x402 call went",
  description: D.report_outcome,
  inputSchema: {
    receipt: z.string().optional().describe("The receipt from a Lumière PayCheck 'allow' decision (paid plans). Or send url + tx instead."),
    url: z.string().optional().describe("The endpoint you paid (with tx, when you have no receipt)"),
    tx: z.string().optional().describe("The payment's transaction hash (Base 0x...) or Solana signature"),
    answers: z.object({
      gotResponse: z.boolean().optional().describe("Did you get a response after paying?"),
      matchedListing: z.enum(["yes", "partly", "no"]).optional().describe("Did it match what the listing promised?"),
      charged: z.enum(["as_quoted", "more", "twice"]).optional().describe("Were you charged the quoted amount, once?"),
      dataUsable: z.enum(["yes", "unsure", "no"]).optional().describe("Did the data look real and usable?"),
      wouldPayAgain: z.boolean().optional().describe("Would you pay this endpoint again?"),
    }).optional(),
    outcome: z.enum(["delivered", "problem"]).optional().describe("Optional shortcut instead of answers: delivered = usable; problem = error, empty, wrong or overcharged"),
    problems: z.array(z.string()).optional().describe("Short descriptions, e.g. 'missing field price', 'HTTP 500'"),
    httpStatus: z.number().int().optional().describe("HTTP status the endpoint returned after payment, e.g. 200 or 500"),
  },
  annotations: { title: "Report how a paid x402 call went", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async (a) => {
  if (!a.receipt && !a.tx) return out({ accepted: false, reason: "send the receipt from an allow decision, or the endpoint url plus the payment tx" }, true);
  const r = await call("POST", "/v1/report", a);
  return out(r.data, r.status !== 200);
});

server.registerTool("top_endpoints", {
  title: "Most trustworthy x402 endpoints",
  description: D.top_endpoints,
  inputSchema: { limit: z.number().int().min(1).max(50).optional().describe("How many endpoints to return, 1-50 (default 10)") },
  annotations: { ...ro, title: "Most trustworthy x402 endpoints" },
}, async ({ limit }) => {
  const r = await call("GET", `/v1/leaderboard?limit=${limit ?? 10}`);
  if (r.status !== 200) return out(r.data, true);
  const endpoints = (r.data.endpoints ?? []).map(s => ({ url: s.url, score: s.score, grade: s.grade, verdict: s.verdict, delivery: s.delivery }));
  return out({ count: endpoints.length, scoredAt: r.data.scoredAt, endpoints });
});

server.registerTool("catalog_stats", {
  title: "x402 catalog statistics",
  description: D.catalog_stats,
  annotations: { ...ro, title: "x402 catalog statistics" },
}, async () => {
  const r = await call("GET", "/v1/stats");
  return out(r.data, r.status !== 200);
});

server.registerTool("get_full_report", {
  title: "How to get a full trust report",
  description: D.get_full_report,
  inputSchema: { url: z.string().describe("Full URL of the x402 endpoint you want the paid report for, including path") },
  annotations: { ...ro, title: "How to get a full trust report" },
}, async ({ url }) => out({
  reportUrl: `${API}/v1/report?url=${encodeURIComponent(url)}`,
  payment: "x402: request the URL, pay the 402 quote (price and network are in the quote) with an x402 client, retry",
  note: "Lookups for endpoints we don't monitor return 404 and are never charged.",
  otherPaidChecks: [
    { what: "Wallet risk before paying any wallet (OFAC sanctions, payout-wallet history, possible hijack)", request: `GET ${API}/v1/wallet-risk?address=<wallet>` },
    { what: "Grades for up to 100 endpoints in one call", request: `POST ${API}/v1/score/batch {"urls":[...]}` },
    { what: "30 days of webhook alerts for one endpoint (down, wallet change, price rise, failed paid test)", request: `POST ${API}/v1/watch {"url":"...","webhook":"https://..."}` },
  ],
  docs: "https://github.com/Book0fEli/lumiere-paycheck/blob/main/docs/api.md",
}));

// ---- prompts: ready-made starting points for people using the server in a chat app ----
server.registerPrompt("check_before_paying", {
  title: "Check an x402 endpoint before paying",
  description: "Check an x402 endpoint's trust grade and, if you have its 402 quote, whether this specific payment should go through.",
  argsSchema: {
    url: z.string().describe("Full URL of the x402 endpoint, e.g. https://api.example.com/v1/data"),
    amount: z.string().optional().describe("Amount from the 402 quote in atomic units (USDC: 10000 = $0.01)"),
    payTo: z.string().optional().describe("payTo wallet from the 402 quote"),
  },
}, ({ url, amount, payTo }) => ({
  messages: [{ role: "user", content: { type: "text", text:
    `Use Lumière PayCheck to check ${url} before paying it. Call check_endpoint for its grade and verdict` +
    (amount || payTo ? `, then call check_payment with${amount ? ` amount ${amount}` : ""}${payTo ? ` and payTo ${payTo}` : ""} and tell me whether it's allowed and why.` : ".") +
    " Summarize in plain words whether it's safe to pay." } }],
}));

server.registerPrompt("safe_endpoints", {
  title: "Find trustworthy x402 endpoints",
  description: "List the x402 endpoints that are currently safest to pay, with their grades and whether a real test payment was delivered.",
  argsSchema: { topic: z.string().optional().describe("Optional: what you need, e.g. 'crypto prices' or 'weather'") },
}, ({ topic }) => ({
  messages: [{ role: "user", content: { type: "text", text:
    `Call top_endpoints with limit 25 and show me the most trustworthy x402 endpoints${topic ? ` that look relevant to ${topic}` : ""}, with grade, verdict, and whether delivery was verified.` } }],
}));

server.registerPrompt("agent_payment_rule", {
  title: "Add a pay-safely rule to your agent",
  description: "A standing instruction that makes your agent check every x402 payment with Lumière PayCheck first.",
}, () => ({
  messages: [{ role: "user", content: { type: "text", text:
    "From now on, before paying any x402 endpoint, call the Lumière PayCheck check_payment tool with the endpoint URL, the amount, and the payTo wallet from its 402 quote. Only pay if allow is true. If allow is false, tell me the reasons instead of paying. After paying, call report_outcome with the url, the payment tx and short answers." } }],
}));

// ---- resources ----
const GUIDE = `# Lumière PayCheck

Checks x402 endpoints before an AI agent pays them.

## Which tool to use
- **check_endpoint**: trust grade (A-F), score (0-100), and verdict for one endpoint.
- **check_payment**: before a specific payment. Send the amount and payTo from the 402 quote; pay only when \`allow\` is true. Catches overpricing and swapped payout wallets.
- **top_endpoints**: the endpoints currently safest to pay.
- **catalog_stats**: catalog size and verdict counts.
- **get_full_report**: how to buy the detailed report (paid via x402).
- **report_outcome**: after paying, report how it went (receipt, or url + payment tx; short answers). Confirmations move the endpoint up our paid-test queue; only our own test changes grades.

## Paid checks (x402, pay per call in USDC; the tools above are free)
- **Full trust report**: \`GET ${API}/v1/report?url=<endpoint>\` (score breakdown, quote, wallet and price history, paid-test results). get_full_report returns the link and price.
- **Wallet risk**: \`GET ${API}/v1/wallet-risk?address=<wallet>\`: OFAC sanctions, whether it's a monitored seller's payout wallet, recent unconfirmed wallet switches. A good second step when check_payment flags a payTo.
- **Batch grades**: \`POST ${API}/v1/score/batch\` with \`{"urls":[...]}\`, up to 100 endpoints, for building a supplier list.
- **Watch**: \`POST ${API}/v1/watch\` with \`{"url","webhook"}\`: 30 days of alerts when an endpoint goes down, changes payout wallet, raises its price, or fails a paid test.
Lookups for endpoints we don't monitor return 404 and are never charged.

## Verdicts
- **proceed**: a real paid test delivered, and it's reliable in monitoring (valid quote, stable wallet and price).
- **caution** (C, D): healthy but not yet paid-tested ("delivery not yet confirmed"), needs its own sign-in, unreliable, an unconfirmed wallet change, or (D) doesn't work as listed though no money is taken. Pay small amounts, or require confirmed delivery with requireVerified.
- **avoid** (F): don't pay: it took the money and failed a paid test (confirmed), an unexplained payout-wallet change, or down more than half the time.
- **free**: serves data without asking for payment.
- **insufficient_data**: too new to judge.

## How scores are made
Every endpoint in the x402 Bazaar is checked every 30 minutes for free (uptime, response time, price and payout-wallet stability). Paid tests confirm delivery: we pay endpoints ourselves and check the response against the seller's own listing. Formula: uptime 40 + latency 15 + stability 25 + delivery 20. Grades can't be bought: sellers of endpoints above $0.05 can fund a test of their own endpoint (the money goes back to their payout wallet), but the grade comes only from what the test finds.
- **A**: we paid and it delivered, cleanly and reliably (95%+ uptime). **B**: we paid and it delivered, with a caveat: reshaped vs its listing (\`listing\`), a value that looks wrong (\`values\`), or 80-95% uptime. **C**: probably works but unconfirmed: not paid-tested yet, needs its own sign-in, refused our test wallet, or customers only (\`auth\`, whose note says which), 50-80% uptime, or an unconfirmed wallet change. **D**: doesn't work as listed, but no money is lost: an error after payment with no charge, the listing's own example input gets "not found" (\`exampleInput\`), or it wants a header or input its listing doesn't document (\`requiredInput\`). **F**: costs money or unsafe: took the money and failed, a payout-wallet incident, or under 50% uptime. A/B = proceed, C/D = caution, F = avoid.
- \`listing\`: the response differs from the seller's example (e.g. fields nested under "data"); it tells you where to read the fields.
- \`values\`: automatic checks on the paid response (it's about what we asked, its timestamp is recent, a token price is near the public spot price).
- A passed paid test stays valid until the price goes up or the payout wallet or network changes. Our own problems (rate limits, our network, our request) never count against a seller.

## Independent buyers
We count customers, not wallets. For the biggest sellers, buyer wallets are grouped by the wallets that funded them with USDC: wallets funded from the same source count as one buyer, and payments from groups of 3+ wallets funded by one source (or by the seller itself) aren't counted as organic. check_endpoint and check_payment return this as \`buyers\`; check_payment's optional \`minOrganicShare\` turns it into a rule. It never changes the grade.`;

server.registerResource("guide", "paycheck://guide", {
  title: "How Lumière PayCheck works",
  description: "What the verdicts and grades mean, how scores are made, and which tool to use when.",
  mimeType: "text/markdown",
}, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE }] }));

server.registerResource("catalog-stats", "paycheck://stats", {
  title: "Catalog statistics",
  description: "How many x402 endpoints are monitored right now and how many fall into each verdict.",
  mimeType: "application/json",
}, async (uri) => {
  const r = await call("GET", "/v1/stats");
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(r.data, null, 2) }] };
});

await server.connect(new StdioServerTransport());
