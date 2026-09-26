# API reference

Base URL: `https://lumierepaycheck.org` · All responses are JSON · CORS is open.

Paid routes use [x402](https://x402.org) on Base mainnet (USDC). Request the route without payment to get the `402` quote, pay it with any x402 client, and retry. Validation errors (4xx) cancel settlement, so **you're never charged for a failed request**.

---

## `GET /v1/score?url=<endpoint>` · free

```json
{ "url": "https://api.example.com/x", "score": 100, "grade": "A", "verdict": "proceed",
  "delivery": "unverified", "probes": 96, "uptimePct": 100 }
```

Unknown endpoint → `404 {"error":"not_monitored"}`.

## `POST /v1/check-payment` · free

Spending rules for agents. Send what you're about to pay; get allow/deny with reasons.

**Body**

```json
{
  "url": "https://api.example.com/x",
  "amount": "10000",
  "payTo": "0xSellerWalletFromThe402Quote",
  "network": "eip155:8453",
  "rules": {
    "maxAmount": "50000",
    "allowCaution": true,
    "requireVerified": false,
    "requireMonitored": true,
    "pinPayTo": true
  }
}
```

Amounts are atomic units (USDC has 6 decimals: `10000` = $0.01). Only `url` is required; rules have the defaults shown.

**Denies when:** the verdict is `avoid`; the verdict is `caution` and `allowCaution` is false; there isn't enough data and `requireMonitored` is true; `requireVerified` is true and no paid test has passed; the payout wallet changed unexpectedly in the last 7 days; `amount` exceeds `maxAmount`; `amount` is higher than the monitored price; `payTo` differs from the monitored wallet (possible hijack); the network differs.

**Response**

```json
{
  "allow": false,
  "reasons": ["payTo differs from the monitored payout wallet (possible hijack)"],
  "monitored": true,
  "url": "https://api.example.com/x",
  "verdict": "proceed", "grade": "A", "score": 100, "delivery": "unverified",
  "observed": { "payTo": "0x…", "amount": "10000", "network": "eip155:8453", "seenAt": "…" }
}
```

## `GET /v1/failures?url=<endpoint>` · free

Every check in the last 7 days that didn't return a valid payment quote.

```json
{ "url": "…", "windowDays": 7, "userAgent": "lumiere-paycheck-prober/1.0 (+https://lumierepaycheck.org)",
  "checkedFrom": "Render, US East (Virginia)",
  "failures": [ { "at": "2026-09-26T15:46:40Z", "status": "blocked", "httpStatus": 429, "detail": "rate limited (HTTP 429)", "counts": false } ] }
```

`status` values:

| Status | Meaning | Counts against uptime? |
|---|---|---|
| `unreachable` | Timeout or connection error, after one retry | Yes |
| `not_x402` | Answered, but not with a payment quote (e.g. 404) | Yes |
| `invalid_402` | Asked for payment, but the quote couldn't be read | Yes |
| `blocked` | Our monitor was rate-limited (429) or blocked by a firewall/bot challenge | No |
| `mismatch` | The endpoint rejected our request shape (400/405/406/411/415/422) before quoting | No |
| `monitor_error` | Our own network had a problem during that cycle | No |
| `unsupported_network` | The quote is for a payment network we can't read yet (e.g. `nano:mainnet`) | No |

## `GET /v1/monitor` · free

Monitor health: politeness settings, which statuses never count, and status counts from the last cycle, including which hosts blocked the monitor.

## `GET /v1/leaderboard?limit=25` · free

Top endpoints graded `proceed` or `caution` with no payout-wallet incidents (max 100).

## `GET /v1/stats` · free

```json
{ "scoredAt": "…", "endpoints": 16894, "byVerdict": { "proceed": 16379, "caution": 113, "avoid": 295, "free": 26, "insufficient_data": 81 } }
```

## `GET /v1/operators?limit=100` · free

Sellers grouped by domain, biggest first: endpoints listed, how many pass, best endpoint.

## `GET /v1/report?url=<endpoint>` · $0.005

Everything in `/v1/score` plus score breakdown, median latency, wallet and price event counts, delivery rate, the current quote (payTo, amount, network), the last 20 events, and the last 10 paid delivery checks.

## `POST /v1/score/batch` · $0.01

**Body:** `{ "urls": ["https://…", "https://…"] }` (1–100 URLs) → `{ "count": 2, "results": [ …score objects… ] }`. Unknown URLs come back with `"monitored": false`.

## `POST /v1/watch` · $0.10

30 days of webhook alerts for one monitored endpoint.

**Body:** `{ "url": "https://api.example.com/x", "webhook": "https://your-server.example.com/alerts" }`

The webhook must be `https` and publicly reachable. **Response** (`201`):

```json
{ "id": "w_…", "token": "SECRET — shown only once", "url": "…", "webhook": "…",
  "createdAt": "…", "expiresAt": "…" }
```

- Status: `GET /v1/watch/<id>?token=<token>`
- Cancel: `DELETE /v1/watch/<id>?token=<token>`

**Alerts** are POSTed as JSON:

```json
{ "type": "endpoint.alert", "watchId": "w_…", "url": "…", "page": "https://lumierepaycheck.org/e?url=…",
  "events": [ { "at": "…", "kind": "wallet_changed", "severity": "critical", "detail": "payTo 0xA… -> 0xB…" } ] }
```

Event kinds: `went_down`, `recovered`, `challenge_broke`, `wallet_changed`, `unauthorized_wallet`, `price_changed` (increases), `network_changed`, `delivery_failed`, `delivery_recovered`. A `watch.created` test alert is sent when the watch is created.

**Verify every alert.** Header `x-paycheck-signature: sha256=<hex>`, where `<hex>` = HMAC-SHA256 of the raw request body, keyed with `sha256(token)` as a lowercase hex string. See [`examples/verify-webhook.ts`](../examples/verify-webhook.ts) and [`examples/verify_webhook.py`](../examples/verify_webhook.py).

## Subscriptions

Plan purchase, agent keys, authorization, receipts, reviews, and audit are documented in **[subscriptions.md](subscriptions.md)**.

| Route | Auth | Purpose |
|---|---|---|
| `GET /v1/plans` | none | Plan catalog |
| `POST /v1/plans/builder`, `/business` | x402 payment (+ owner key to renew/upgrade) | Buy, renew, or upgrade with USDC. Card subscriptions: [/subscribe](https://lumierepaycheck.org/subscribe) |
| `POST /billing/portal` | owner key (card plans) | Stripe billing-portal link: card, plan changes, invoices, cancel |
| `GET`, `PATCH /v1/workspace` | owner key | Plan status; set `reviewWebhook` |
| `POST`, `GET /v1/agents` · `GET`, `PATCH`, `DELETE /v1/agents/:id` · `POST /v1/agents/:id/rotate` | owner key | Manage scoped agent keys |
| `POST /v1/authorize` | agent key | Allow / deny / review a payment; receipt on allow |
| `GET /v1/decisions` · `GET /v1/decisions/:id` | owner key (agents can read their own decision) | Audit log, full decision context |
| `POST /v1/decisions/:id/replay` | owner key | Re-run a stored decision; confirms `matches: true` |
| `GET /v1/audit.csv` | owner key (Business+) | CSV export |
| `GET /v1/reviews` · `POST /v1/reviews/:id/approve`, `/deny` | owner key (Business+) | Human review queue |
| `GET /.well-known/paycheck-receipt-key.json` | none | Ed25519 public key (JWK) for offline receipt verification |
| `POST /v1/receipts/verify` | none | Verify a receipt online |

Keys go in `Authorization: Bearer <key>`. Owner keys start with `pc_owner_`, agent keys with `pc_agent_`.

## MCP

Remote server (Streamable HTTP): `https://lumierepaycheck.org/mcp`

| Tool | Purpose |
|---|---|
| `check_payment` | Spending rules for a specific payment (same as `/v1/check-payment`) |
| `check_endpoint` | Score, grade, verdict, advice |
| `top_endpoints` | Most trustworthy endpoints |
| `catalog_stats` | Catalog size and verdict counts |
| `get_full_report` | How to buy the full report |

## Rate limits

Free routes: 60 requests/minute per client, with `ratelimit-limit`, `ratelimit-remaining`, and `retry-after` headers. Over the limit → `429`. For volume, use `/v1/score/batch`.
