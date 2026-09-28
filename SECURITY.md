# Security at Lumière PayCheck

Lumière PayCheck decides whether an AI agent's payment should happen. It never holds, routes, or escrows anyone's money, and it keeps as little data as the service needs. This page describes how the service actually works today, including its current limitations.

Operated by Lumière LLC (Connecticut, USA). Contact: hello@lumierepaycheck.org.

## What we store

- **Public monitoring data:** the price quotes, payout wallets, uptime, and response times of public x402 endpoints, plus public on-chain USDC settlements (Base and Solana) into those endpoints' payout wallets.
- **Subscriber workspaces:** plan, expiry, agent names and limits, and **hashed** keys. Keys are never stored in plain text.
- **Payment decisions:** each authorization's inputs (endpoint, amount, payout wallet) and its outcome, kept for your plan's audit period so decisions can be replayed.
- **Card billing:** handled entirely by Stripe. We store only Stripe's customer and subscription IDs. Card numbers never reach our servers.
- **Email addresses, only when you provide them:** to look up your subscription for key recovery, and in enterprise inquiries (name, work email, company, message).
- **Outcome reports:** which endpoint, delivered or problem, and optionally a transaction hash. They're linked to your workspace internally and shown publicly only as totals per endpoint, never tied to who reported.
- **No IP address logs in our database:** rate limits are counted in memory and cleared every minute. Daily visitor counts use a scrambled code built from a secret that changes each day and is then deleted, so visits can't be traced across days or back to an address.

## Keys and authentication

- **Owner and agent keys** are 192-bit random values, shown once, and stored only as SHA-256 hashes. We keep a short prefix to help you tell keys apart.
- **Agent keys are scoped:** allowed sellers, a per-payment cap, daily and monthly limits, and an expiry. Owners can revoke or replace any key instantly.
- **Owner key recovery** sends a one-time link to the email Stripe has on file. The link expires in 24 hours, works once, and is stored hashed; claiming it issues a new key and revokes the old one immediately. The recovery page gives the same answer whether or not an account exists.
- **Enterprise onboarding without handling keys:** clients receive a one-time access link (7 days, single use, stored hashed; opening it doesn't consume it) and create their own owner key, so the operator never sees it. Clients can have additional administrators, each with their own key that can be revoked individually.
- **The operator inbox** requires a separate admin key of at least 24 characters, compared in constant time. Every change the operator makes to a client's workspace is recorded in a change log.

## Payments and funds

- **No custody.** We never hold, route, or escrow customer funds. Agents pay sellers directly from their own wallets; Lumière PayCheck only answers whether a payment should happen.
- **Signed receipts.** An "allow" comes with an Ed25519 signature over the exact payment (endpoint, amount, payout wallet, decision ID), so a wallet can refuse to pay without one. The public key is published at `/.well-known/paycheck-receipt-key.json`.
- **Subscriptions** use Stripe Checkout. Stripe webhooks are verified with HMAC-SHA256 signatures and a 5-minute replay window. USDC plans are paid through an x402 facilitator.
- **The verifier wallet** is a small, separately funded wallet used only for paid delivery checks. Each check is capped at $0.05 and automatic checks target endpoints priced at $0.01 or less. Its key is held as a server secret, and the operator is alerted when its balance runs low.

## Application security

- **HTTPS only**, with HSTS, a strict Content Security Policy (no inline scripts), clickjacking protection (`X-Frame-Options: DENY`), `nosniff`, a referrer policy, and a permissions policy. Cross-origin access is limited to the API routes.
- **Database queries are parameterized** (prepared statements), never built from strings.
- **Outbound webhooks** (watch alerts, review notifications) must resolve to public internet addresses; private and internal ranges are blocked. Alerts are signed with HMAC-SHA256.
- **Rate limits** protect the free API, checkout, key recovery, enterprise inquiries, outcome reports, and grade disputes.
- **Secrets** live in the hosting provider's environment settings, never in source code, and are masked in logs. Blockchain node URLs that contain provider API keys are never logged.
- **Community reports** require a valid signed receipt, count one vote per customer, weigh reporters by track record, ignore coordinated bursts from new accounts, and can only trigger our own re-test: they never change a grade by themselves.

## Infrastructure and operations

- Hosted on **Render** in the **US East (Virginia)** region: one application instance with a SQLite database on a persistent disk.
- Public blockchain data is read through **blockchain node providers** (a public Base node and a Solana RPC provider). They see which public wallets we query, never customer data.
- Source code is in a **private GitHub repository** and deploys automatically from the main branch. Public documentation and examples are at github.com/Book0fEli/lumiere-paycheck.
- **Encrypted off-site backups:** every night the database is snapshotted, compressed, encrypted with AES-256-GCM using a key held only by the operator, and stored in Cloudflare R2 (7 daily and 4 weekly copies). The operator is alerted if a backup fails.
- **No third-party requests from our pages:** fonts and scripts are served from our own domain, so visiting the site doesn't contact any other company.
- **Automatic health monitoring:** the host restarts the service if it stops responding, and the operator is emailed about low verifier funds, disk or catalog capacity, and payment configuration problems, plus a weekly summary.

## Data retention

- Endpoint monitoring checks: full detail for 2 days; after that, successful checks are condensed into hourly totals (8 days) and then daily totals (90 days). Failed checks stay individually for 8 days for the public failure log. Events and paid delivery results: 90 days. Individual settlement records: 31 days; daily settlement totals per payout wallet: 1 year.
- Payment decisions: 30 days on Builder, 1 year on Business.
- Outcome reports: 90 days. Key recovery requests: 30 days. Closed enterprise inquiries: 1 year.
- Workspaces remain until you ask us to delete them (email hello@lumierepaycheck.org).

## Reporting a vulnerability

Please report security issues privately, not in a public issue:

- **GitHub:** github.com/Book0fEli/lumiere-paycheck/security/advisories/new
- **Email:** hello@lumierepaycheck.org

We aim to acknowledge reports within three business days and will keep you updated until the issue is resolved. Please don't access other users' data or disrupt the service while testing.

## Current limitations

We'd rather you hear these from us:

- **No SOC 2 or ISO 27001 certification yet,** and no third-party penetration test yet.
- **Single region and single instance:** deploys and restarts cause brief interruptions.
- **Small team:** the service is operated by a single founder, with automated monitoring and alerts.
- **The receipt signing key is stored in the application database** on the server's disk (and therefore in the encrypted backups).

Our [privacy policy](https://lumierepaycheck.org/privacy) covers what personal information we collect and who else handles it. Questions for a security review or vendor questionnaire: hello@lumierepaycheck.org, or use the private [Enterprise form](https://lumierepaycheck.org/enterprise).
