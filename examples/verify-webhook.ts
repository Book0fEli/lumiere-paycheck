// Verify a Lumière PayCheck watch alert before trusting it.
// Signature header: x-paycheck-signature: sha256=<hex>
//   <hex> = HMAC-SHA256(rawBody) keyed with sha256(token) as a lowercase hex string.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function verifyAlert(rawBody: string, signatureHeader: string | undefined, token: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const key = createHash("sha256").update(token).digest("hex");
  const expected = createHmac("sha256", key).update(rawBody).digest("hex");
  const got = signatureHeader.slice("sha256=".length);
  return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

// Minimal receiver (Node's built-in http). Set WATCH_TOKEN to the token from POST /v1/watch.
import { createServer } from "node:http";
if (process.env.WATCH_TOKEN) {
  createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      if (!verifyAlert(body, req.headers["x-paycheck-signature"] as string, process.env.WATCH_TOKEN!)) {
        res.statusCode = 401; return res.end("bad signature");
      }
      const alert = JSON.parse(body);
      console.log(alert.type, alert.url, alert.events ?? "");
      res.end("ok");
    });
  }).listen(8787, () => console.log("listening on :8787"));
}
