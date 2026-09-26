<p align="center">
  <img src="assets/1-homepage.png" alt="Lumière PayCheck homepage" width="820">
</p>

# Lumière PayCheck

**Check an x402 endpoint before your agent pays it.**

AI agents now pay for APIs on their own with [x402](https://x402.org): an endpoint answers `402 Payment Required` with a price, the agent pays in USDC, and gets the data. Nothing in that flow tells the agent whether the endpoint works, whether the price is right, or whether the payout wallet is the real one.

Lumière PayCheck answers those questions. It monitors every endpoint listed in the x402 Bazaar, grades each one, and gives your agent a plain verdict: **proceed**, **caution**, or **avoid**.

🌐 **Live:** https://lumierepaycheck.org  ·  🔌 **MCP:** `https://lumierepaycheck.org/mcp`  ·  📜 [Terms](https://lumierepaycheck.org/terms)

> This repository is the public home for docs, examples, and feedback. The monitoring service itself is hosted and closed-source; the scoring formula is public (below).

---

## What it does

- **Monitors ~17,000 x402 endpoints** from the Bazaar, every 30 minutes: price quote, payout wallet, uptime, response time.
- **Flags hijack risk.** If an endpoint's payout wallet changes unexpectedly, its score is capped and agents are told to avoid it.
- **Spending rules for agents.** Before paying, an agent asks "may I pay *this* endpoint *this* amount to *this* wallet?" and gets allow or deny with reasons.
- **Alerts.** Watch an endpoint and get signed webhook alerts when it breaks, changes wallet, or raises its price.
- **Paid delivery checks** (rolling out): small real payments that confirm an endpoint returns what it advertises.

No accounts, no API keys. Free checks are free; paid features are paid per call with x402, the same way agents pay everything else.

## Quick start

### 1. From Claude, Cursor, or any MCP client

Add the remote MCP server:

```
https://lumierepaycheck.org/mcp
```

- **Claude:** Settings → Connectors → Add custom connector → paste the URL.
- **Cursor / others** (`mcp.json`):
  ```json
  { "mcpServers": { "lumiere-paycheck": { "url": "https://lumierepaycheck.org/mcp" } } }
  ```

Tools: `check_payment`, `check_endpoint`, `top_endpoints`, `catalog_stats`, `get_full_report`.

Then add one rule to your agent's instructions:

> Before paying any x402 endpoint, call the Lumière PayCheck `check_payment` tool with the endpoint URL, the amount, and the payTo wallet from its 402 quote. Only pay if `allow` is true. If it returns `allow: false`, tell me the reasons instead of paying.

### 2. From code

```ts
// Before paying any x402 endpoint, ask Lumière PayCheck.
const res = await fetch("https://lumierepaycheck.org/v1/check-payment", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: target, amount: quote.amount, payTo: quote.payTo }),
});
const decision = await res.json();
if (!decision.allow) throw new Error(`Not paying ${target}: ${decision.reasons.join("; ")}`);
// ...then pay with your x402 client as usual
```

More in [`examples/`](examples): TypeScript, Python, curl, and webhook signature verification.

<p align="center">
  <img src="assets/2-for-agent-builders.png" alt="For agent builders section" width="820">
</p>

## API

| Route | Price | What it does |
|---|---|---|
| `GET /v1/score?url=` | Free | Score, grade, verdict for one endpoint |
| `POST /v1/check-payment` | Free | Spending rules: allow/deny a specific payment, with reasons |
| `GET /v1/leaderboard?limit=` | Free | Top-rated endpoints (no wallet incidents) |
| `GET /v1/stats` | Free | Catalog size and verdict counts |
| `GET /v1/operators?limit=` | Free | Sellers grouped by domain |
| `GET /v1/failures?url=` | Free | Every failed check in the last 7 days: time, result, HTTP status, and whether it counts |
| `GET /e?url=` | Free | Public page for one endpoint, including its failed-check log |
| `GET /badge?url=` | Free | Embeddable SVG badge |
| `GET /v1/report?url=` | $0.005 | Full report: score breakdown, current quote, wallet and price history |
| `POST /v1/score/batch` | $0.01 | Score up to 100 endpoints in one call |
| `POST /v1/watch` | $0.10 | 30 days of signed webhook alerts for one endpoint |

Free routes allow 60 requests per minute per client. Paid routes use x402 on **Base mainnet** (USDC). Lookups for endpoints we don't monitor return 404 and are **never charged**. Full reference: [`docs/api.md`](docs/api.md).

## Verdicts

| Verdict | Meaning |
|---|---|
| `proceed` | Score ≥ 75, no wallet incidents, no failed deliveries |
| `caution` | Score 40–74 |
| `avoid` | Score < 40, an unexplained payout-wallet change, or a failed paid delivery |
| `free` | Serves data without asking for payment |
| `insufficient_data` | Fewer than 3 checks so far |

## How a score is made

<p align="center">
  <img src="assets/3-how-it-works.png" alt="How it works and scoring formula" width="820">
</p>

Deterministic and public. **No one can pay for a better grade.**

- **Uptime 40:** how often the endpoint returns a valid payment quote over 7 days
- **Latency 15:** full points at ≤ 500 ms median, zero at ≥ 3,000 ms
- **Stability 25:** drops with payout-wallet changes and price increases
- **Delivery 20:** share of paid test payments that returned what was advertised
- Not yet paid-tested → scored on the other 80 points, rescaled, and labeled so
- **Caps:** unexplained wallet change → max 40; failed paid delivery → max 50
- A failed payment caused on our side never counts against a seller
- **Fair to sellers:** checks where our monitor is rate-limited or bot-challenged (e.g. by Cloudflare) are logged as `blocked` and never count against uptime; dropped connections are retried once; we never send more than 2 requests at a time to one host
- **Transparent:** every failed check is listed on the endpoint's public page and at `/v1/failures`, with timestamps. Our user agent is `lumiere-paycheck-prober/1.0 (+https://lumierepaycheck.org)` if you want to allowlist it

## Pricing

<p align="center">
  <img src="assets/4-pricing.png" alt="Pricing" width="820">
</p>

## For sellers

Every monitored endpoint has a public page and a badge that updates on its own:

```markdown
[![Lumière PayCheck](https://lumierepaycheck.org/badge?url=YOUR_ENDPOINT_URL_ENCODED)](https://lumierepaycheck.org/e?url=YOUR_ENDPOINT_URL_ENCODED)
```

Think a grade is wrong? [Open an issue](../../issues) with the endpoint URL.

## Independence

Lumière PayCheck is an independent project operated by **Lumière LLC** (Connecticut, USA). It is not affiliated with Coinbase, the x402 Foundation, the Bazaar, or any seller. Scores are automated assessments, not guarantees, endorsements, or financial advice.

## Feedback

Questions, feature requests, and grade disputes: [open an issue](../../issues). Building an agent that pays with x402? I'd love to hear what it needs.

## License

The documentation and example code in this repository are [MIT licensed](LICENSE). The Lumière PayCheck hosted service and its source code are not part of this repository and are not covered by this license.
