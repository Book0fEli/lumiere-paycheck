// Enforcement at the tool boundary: an x402 payer that REFUSES to pay unless
// Lumière PayCheck allowed this exact payment and the receipt verifies.
//
//   npm i @x402/fetch @x402/evm viem
//   AGENT_KEY=pc_agent_... WALLET_KEY=0x... npx tsx examples/guarded-pay.ts https://api.example.com/x
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { verifyReceipt } from "./verify-receipt";

const PAYCHECK = process.env.PAYCHECK_URL ?? "https://lumierepaycheck.org";

export function guardedFetch(agentKey: string, walletKey: `0x${string}`) {
  const signer = privateKeyToAccount(walletKey);

  return async (url: string, init?: RequestInit) => {
    // 1. Unpaid request to read the quote.
    const first = await fetch(url, init);
    if (first.status !== 402) return first;
    const header = first.headers.get("payment-required");
    const quote = header
      ? JSON.parse(Buffer.from(header, "base64").toString("utf8")).accepts[0]
      : (await first.json()).accepts[0];
    const amount = String(quote.amount ?? quote.maxAmountRequired), payTo = String(quote.payTo), network = String(quote.network);

    // 2. Ask Lumière PayCheck whether this exact payment is allowed.
    const res = await fetch(`${PAYCHECK}/v1/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentKey}` },
      body: JSON.stringify({ url, amount, payTo, network }),
    });
    const d = await res.json() as { outcome: string; reasons: string[]; receipt?: string; decision: string };
    if (d.outcome !== "allow" || !d.receipt) {
      throw new Error(`Payment ${d.outcome} by Lumière PayCheck (${d.decision}): ${d.reasons.join("; ")}`);
    }

    // 3. Verify the receipt is genuine and for THIS payment.
    await verifyReceipt(d.receipt, { url, amount, payTo, network });

    // 4. Pay, pinned to exactly what was authorized: x402's policy hook filters
    //    which payment options may be signed. If the server swaps the wallet or
    //    raises the price between the check and the payment, nothing is signed.
    const pin = (_v: number, reqs: any[]) => reqs.filter(r =>
      String(r.payTo).toLowerCase() === payTo.toLowerCase() &&
      String(r.network) === network &&
      BigInt(r.amount ?? r.maxAmountRequired) <= BigInt(amount));
    const client = registerExactEvmScheme(new x402Client(), { signer, policies: [pin as any] });
    return wrapFetchWithPayment(fetch, client)(url, init);
  };
}

const [target] = process.argv.slice(2);
if (target && process.env.AGENT_KEY && process.env.WALLET_KEY) {
  guardedFetch(process.env.AGENT_KEY, process.env.WALLET_KEY as `0x${string}`)(target)
    .then(async r => console.log(r.status, (await r.text()).slice(0, 300)))
    .catch(err => { console.error(err.message); process.exitCode = 1; });
}
