// Before paying any x402 endpoint, ask Lumière PayCheck whether this exact
// payment (endpoint + amount + payout wallet) is safe. Node 18+ (global fetch).
//
//   npx tsx examples/check-before-pay.ts https://api.example.com/x 10000 0xSellerWallet

const API = "https://lumierepaycheck.org";

export interface Decision {
  allow: boolean;
  reasons: string[];
  verdict: string | null;
  grade?: string;
  observed?: { payTo: string | null; amount: string | null; network: string | null } | null;
}

export async function checkPayment(url: string, amount?: string, payTo?: string, maxAmount?: string): Promise<Decision> {
  const res = await fetch(`${API}/v1/check-payment`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, amount, payTo, rules: maxAmount ? { maxAmount } : undefined }),
  });
  if (res.status === 429) throw new Error("rate limited: slow down or use /v1/score/batch");
  if (!res.ok) throw new Error(`check failed: HTTP ${res.status}`);
  return res.json() as Promise<Decision>;
}

// Example: run from the command line.
const [url, amount, payTo] = process.argv.slice(2);
if (url) {
  checkPayment(url, amount, payTo, "50000") // never more than $0.05
    .then(d => {
      console.log(d.allow ? "✅ allowed" : "⛔ denied", "-", d.reasons.join("; "));
      if (d.observed) console.log("monitored quote:", d.observed);
    })
    .catch(err => { console.error(err.message); process.exitCode = 1; });
}
