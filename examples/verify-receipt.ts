// Verify a Lumière PayCheck receipt OFFLINE before letting an agent pay.
// Node 16+. Fetch the public key once and cache it.
import { createPublicKey, verify } from "node:crypto";

const KEY_URL = `${process.env.PAYCHECK_URL ?? "https://lumierepaycheck.org"}/.well-known/paycheck-receipt-key.json`;

export interface ReceiptPayload {
  v: number; kid: string; decision: string; workspace: string; agent: string;
  url: string; amount: string; payTo: string | null; network: string | null;
  outcome: "allow"; iat: number; exp: number;
}

let cachedKey: ReturnType<typeof createPublicKey> | null = null;
async function publicKey() {
  if (!cachedKey) {
    const { keys } = await (await fetch(KEY_URL)).json() as { keys: Record<string, string>[] };
    cachedKey = createPublicKey({ key: keys[0] as any, format: "jwk" });
  }
  return cachedKey;
}

export async function verifyReceipt(receipt: string, expected: { url: string; amount: string; payTo: string; network?: string }): Promise<ReceiptPayload> {
  const [body, sig] = receipt.split(".");
  if (!body || !sig) throw new Error("malformed receipt");
  if (!verify(null, Buffer.from(body), await publicKey(), Buffer.from(sig, "base64url"))) throw new Error("bad signature");
  const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ReceiptPayload;
  if (p.outcome !== "allow") throw new Error("receipt is not an allow");
  if (p.exp < Date.now() / 1000) throw new Error("receipt expired");
  // Bind the receipt to THIS payment, or a valid receipt could be reused for another one.
  if (p.url !== expected.url) throw new Error("receipt is for a different URL");
  if (p.amount !== expected.amount) throw new Error("receipt is for a different amount");
  if ((p.payTo ?? "").toLowerCase() !== expected.payTo.toLowerCase()) throw new Error("receipt is for a different wallet");
  if (expected.network && p.network && p.network !== expected.network) throw new Error("receipt is for a different network");
  return p;
}
