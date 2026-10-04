// Compile-only: withPayCheck accepts the real x402Client from @x402/fetch.
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { withPayCheck, wrapFetchWithPayCheck } from "../src/index.js";
const c = withPayCheck(new x402Client());
const f = wrapFetchWithPayCheck(fetch, new x402Client(), wrapFetchWithPayment, { apiKey: "k" });
void c; void f;
