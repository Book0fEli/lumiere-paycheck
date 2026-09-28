# Privacy policy

Lumière PayCheck (lumierepaycheck.org) is operated by **Lumière LLC**, a Connecticut limited liability company. This policy explains what personal information we collect, why, how long we keep it, and who else handles it. Questions: **hello@lumierepaycheck.org**.

Last updated: September 28, 2026 (enterprise clients section added).

## The short version

- We collect as little as the service needs. You can check any endpoint without an account and without giving us anything.
- We never sell personal information, never show ads, and use no tracking cookies.
- We don't store visitors' IP addresses. Visitor counts use a daily-rotating code that can't be traced across days.
- Card payments are handled by Stripe; card numbers never reach us.

## What we collect

**When you use the free site, API, or MCP server:** the endpoint you ask about and your request, which we answer and count. We count how often each endpoint is looked up, without recording who looked it up.

**Visitor statistics:** to count daily visitors, we combine your IP address and browser type with a secret that changes every day, scramble them into a short code, and count distinct codes. The daily secret is deleted after the day ends, so codes can't be linked across days or turned back into an address. We keep only totals (visitors, page views, API calls) per day.

**If you subscribe:**

- **By card:** Stripe collects your payment details and email. We receive and store only Stripe's customer and subscription IDs, not your card number.
- **With USDC (x402):** the payment is a public blockchain transaction from your wallet. We don't collect anything beyond what that transaction publicly shows.
- **Your workspace:** plan, expiry, agent names, limits and settings, and **hashed** keys (never the keys themselves).
- **Payment decisions:** when your agents ask whether to pay, we store each decision's inputs (endpoint, amount, payout wallet) and outcome for your plan's audit period.
- **Outcome reports** (on by default, can be turned off): whether a paid call delivered. Shown publicly only as totals per endpoint, never tied to you.

**If you're an enterprise client:** your company name, contact email, the names and email addresses of administrators you or we invite, your agreed terms, and records of invoices (number, amount, dates, paid status). Access links we send are single-use, expire after 7 days, and are stored only in scrambled (hashed) form.

**If you contact us:** the enterprise form collects your name, work email, company, role, and message. Key recovery asks for your checkout email to find your subscription. Emails you send us are kept in our inbox.

**Public data about endpoints and sellers:** we monitor public x402 endpoints (price quotes, payout wallets, uptime) and read public blockchain payments into their payout wallets. This concerns services and wallets, not visitors, but a payout wallet can belong to an individual seller.

## Why we use it

To run the service (answer checks, authorize payments, keep audit trails), to bill subscriptions, to recover access, to reply to inquiries, to protect the service from abuse (rate limits, spam checks), and to understand overall usage through the totals above.

## Cookies and browser storage

We set **no cookies**. If you sign in to your account page, your owner key is kept in your browser's session storage (cleared when the tab closes), or in local storage if you choose "keep me signed in." Stripe's checkout page, which is on Stripe's own site, uses its own cookies under Stripe's policy.

## Who else handles data

We use these service providers, only for the purposes listed:

- **Render** (hosting, United States): runs the service and stores its database.
- **Stripe** (card payments): checkout, billing, and receipts.
- **Resend** (email delivery): sends key recovery and access links, inquiry confirmations, renewal reminders, and operator alerts.
- **Cloudflare** (DNS, email routing, and encrypted backup storage).
- **Proton** (email inbox): receives mail sent to hello@lumierepaycheck.org.
- **Blockchain data providers** (a public Base node and a Solana provider such as Helius): we ask them about public wallets and transactions, never about you.
- **GitHub** (code hosting, and the public repository's issues and discussions if you use them).

Our fonts are hosted on our own server, so loading our pages doesn't contact any third party. We may disclose information if required by law or to protect the service and its users. If Lumière LLC is ever sold or merged, this information may transfer with the business under the same protections.

## How long we keep it

- Visitor totals: kept as daily totals; the daily secret is deleted after each day.
- Payment decisions: 30 days on Builder, 1 year on Business.
- Outcome reports: 90 days. Key recovery requests: 30 days. Closed enterprise inquiries: 1 year.
- Workspaces, their administrators, and invoice records: until you ask us to delete them (we may keep invoice records longer where tax or accounting law requires).
- Encrypted backups: the most recent 7 daily and 4 weekly copies; older ones are deleted automatically.
- Monitoring and settlement data about public endpoints: see our [security page](https://lumierepaycheck.org/security) for the full schedule.

## Security

Keys are stored only as hashes, backups are encrypted before they leave our server, and we never hold customer funds. Details, including current limitations: [lumierepaycheck.org/security](https://lumierepaycheck.org/security).

## Your choices and rights

You can ask us to access, correct, or delete your information, or to stop processing it, by emailing hello@lumierepaycheck.org. You can turn off outcome reporting on your account page, cancel a card subscription anytime from the billing portal, and delete your workspace by asking us. Depending on where you live, you may have additional rights under local law, and we'll honor valid requests. We'll respond within 30 days.

## Children

The service is for businesses and developers and isn't directed to children. We don't knowingly collect information from anyone under 16. If you believe a child has given us information, contact us and we'll delete it.

## Where data is processed

Our servers and most of our providers are in the United States. By using the service from elsewhere, you understand your information will be processed in the United States.

## Changes

If we change this policy, we'll update the date above, and for significant changes we'll post a notice on the site before they take effect.

## Contact

Lumière LLC · Connecticut, USA · hello@lumierepaycheck.org
