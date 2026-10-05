# x402-paycheck

Check every x402 payment with [Lumière PayCheck](https://lumierepaycheck.org) before your agent pays it. One line on top of the standard `@x402/fetch` client.

Before your agent signs a payment, PayCheck checks:

- **Trust grade:** uptime, response time, price and payout-wallet stability, and real paid delivery tests across 21,000+ monitored x402 endpoints
- **Price:** the quote isn't higher than the price PayCheck has been monitoring
- **Payout wallet:** the wallet hasn't been swapped (a common sign of a hijacked endpoint)
- **Sanctions:** the wallet isn't on the U.S. Treasury OFAC sanctions list
- **Real buyers (optional):** with `minOrganicShare`, enough of the seller's volume comes from independent buyers, not wallets one operator created. We count customers, not wallets.

If PayCheck says no, the payment is never created.

## Install

```bash
npm i x402-paycheck @x402/fetch
```

## Use

```ts
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { withPayCheck } from "x402-paycheck";

const client = withPayCheck(
  new x402Client().register("eip155:8453", new ExactEvmScheme(signer)),
);
const fetchWithPay = wrapFetchWithPayment(fetch, client);

const res = await fetchWithPay("https://api.example.com/paid-endpoint");
```

A blocked payment throws from `fetchWithPay` with the reason, for example:

```
Payment creation aborted: Lumière PayCheck: deny: payTo differs from the monitored payout wallet (possible hijack)
```

`client.lastPayCheckDecision` holds the most recent decision for logging.

### Servers on the older x402 v1 format

v1 price quotes don't include the endpoint URL, so use the wrapper, which passes the request URL to PayCheck:

```ts
import { wrapFetchWithPayCheck } from "x402-paycheck";

const fetchWithPay = wrapFetchWithPayCheck(fetch, client, wrapFetchWithPayment);
```

## Options

```ts
withPayCheck(client, {
  apiKey: "pc_free_...",        // free API key for a higher rate limit: lumierepaycheck.org/#free-key
  rules: { maxAmount: "50000", allowCaution: false, requireVerified: true },
  failOpen: false,           // if PayCheck can't be reached: block (default) or allow
  onDecision: (d) => console.log(d.outcome, d.reasons),
});
```

| Rule | Default | Meaning |
|---|---|---|
| `maxAmount` | none | Hard cap per payment, atomic units (USDC: `1000000` = $1) |
| `allowCaution` | `true` | Allow "caution" endpoints. Caution includes healthy endpoints not yet paid-tested, so `false` limits payments to endpoints a real paid test confirmed |
| `requireVerified` | `false` | Only pay endpoints that passed a real paid delivery test |
| `requireMonitored` | `true` | Block endpoints PayCheck doesn't monitor |
| `pinPayTo` | `true` | The payout wallet must match the monitored one |
| `allowUnconfirmedWallet` | `false` | Allow a recent wallet change nobody could confirm |
| `minOrganicShare` | off | Only pay sellers where at least this share (0-1) of 30-day volume comes from independent buyers |

## Teams: spend limits and signed receipts

With a [PayCheck plan](https://lumierepaycheck.org/subscribe), give each agent its own key. Payments then go through `/v1/authorize`: per-agent daily and monthly limits, allowed sellers, human review for unusual payments, a full audit trail, and a signed receipt for every allowed payment.

```ts
const client = withPayCheck(baseClient, { agentKey: process.env.PAYCHECK_AGENT_KEY });
// client.lastPayCheckDecision.receipt -> signed receipt for the allowed payment
```

A decision sent to human review counts as "not allowed" until someone approves it.

## Just the check

```ts
import { checkPayment } from "x402-paycheck";

const d = await checkPayment({ url, amount: "10000", payTo: "0x...", network: "eip155:8453" });
if (!d.allow) console.log(d.reasons);
console.log(d.buyers); // { reviewed, independentBuyers30d, buyerWallets30d, organicShare, flags }
```

## After paying: report how it went

One line after a paid call tells PayCheck whether you got what you paid for. It's free and optional, and no account is needed: the payment's transaction is read from the paid response and checked on-chain.

```ts
import { reportOutcome } from "x402-paycheck";

const res = await fetchWithPay(url, init);
await reportOutcome({ url, response: res, answers: { matchedListing: "yes", dataUsable: "yes", charged: "as_quoted", wouldPayAgain: true } });
// -> { accepted: true, outcome: "delivered", ourTestQueued: true, verifiedOnChain: true }
```

`gotResponse` and the HTTP status are filled in from `response`. On a team plan, pass `receipt: client.lastPayCheckDecision?.receipt` instead. Confirmations from independent buyers move the endpoint up PayCheck's own paid-test queue; serious problems (nothing came back, charged more or twice) trigger a re-test. Reports never change a grade by themselves. `reportOutcome` never throws: if PayCheck can't be reached, it returns `{ accepted: false, reason }`.

## Links

- Docs and API reference: https://github.com/Book0fEli/lumiere-paycheck
- MCP server: `https://lumierepaycheck.org/mcp`
- Questions: hello@lumierepaycheck.org

Lumière PayCheck is operated by Lumière LLC. Scores are automated assessments, not guarantees or financial advice.
