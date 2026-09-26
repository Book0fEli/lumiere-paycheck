// Buy (or renew/upgrade) a Lumière PayCheck plan with x402.
//
//   npm i @x402/fetch @x402/evm viem
//   WALLET_KEY=0x... npx tsx examples/subscribe.ts builder
//   WALLET_KEY=0x... OWNER_KEY=pc_owner_... npx tsx examples/subscribe.ts business   # renew / upgrade
//
// The wallet needs USDC on Base. Save the ownerKey printed on first purchase.
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const plan = process.argv[2] ?? "builder";
if (!["builder", "business"].includes(plan)) throw new Error("plan must be builder or business");
const client = registerExactEvmScheme(new x402Client(), { signer: privateKeyToAccount(process.env.WALLET_KEY as `0x${string}`) });
const payFetch = wrapFetchWithPayment(fetch, client);

const headers: Record<string, string> = { "content-type": "application/json" };
if (process.env.OWNER_KEY) headers.authorization = `Bearer ${process.env.OWNER_KEY}`;
payFetch(`https://lumierepaycheck.org/v1/plans/${plan}`, { method: "POST", headers, body: "{}" })
  .then(async r => console.log(r.status, JSON.stringify(await r.json(), null, 2)))
  .catch(err => { console.error(err.message); process.exitCode = 1; });
