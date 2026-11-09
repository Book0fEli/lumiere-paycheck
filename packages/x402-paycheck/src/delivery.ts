// After paying: did the paid call deliver what the listing promised? (v0.4.0)
//
// verifyDelivery(response, { quote }) checks a paid response against the 402 quote's own listing (the example output in
// extensions.bazaar for x402 v2, outputSchema for v1), with the same rules Lumière PayCheck's paid tests use:
//   - an error status after payment is a failure;
//   - an empty body, or not-JSON when the listing promises JSON, is a failure;
//   - with an example: the response must carry at least one of its fields (at the top level or inside a wrapper such
//     as { data: ... }); an honest empty result list is fine;
//   - with a JSON Schema: types and required fields must match.
// It reads a clone of the response, so your code can still read the body.
import { matchesExample, validateSchema, isEmptyResult, type JsonSchema } from "./validate.js";

export interface DeliveryCheck {
  ok: boolean;
  problems: string[];                       // plain descriptions, e.g. "none of the example's fields (price) in the response"
  checked: "example" | "schema" | "status";  // what the response was compared with ("status": the listing had no output to compare)
  matchedListing: "yes" | "no" | "unsure";
  dataUsable: "yes" | "no" | "unsure";
  httpStatus: number;
}

export interface ExpectedOutput { example?: unknown; schema?: JsonSchema; json?: boolean }

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const looksLikeSchema = (v: unknown) => isObj(v) && (typeof v.type === "string" || Array.isArray(v.type)) && (isObj(v.properties) || isObj(v.items) || Array.isArray(v.required));

/** What a 402 quote says the paid response looks like (x402 v2 bazaar extension, or v1 outputSchema). */
export function expectedOutput(quote: any): ExpectedOutput {
  if (!isObj(quote)) return {};
  const mime = String(quote.resource?.mimeType ?? quote.accepts?.[0]?.mimeType ?? "").toLowerCase();
  const out: ExpectedOutput = mime ? { json: mime.includes("json") } : {};
  const v2 = quote.extensions?.bazaar?.info?.output;
  const v1 = Array.isArray(quote.accepts) ? quote.accepts.map((a: any) => a?.outputSchema?.output).find((x: unknown) => x !== undefined) : undefined;
  for (const o of [v2, v1]) {
    if (!isObj(o)) continue;
    if (o.example !== undefined) { out.example = o.example; break; }
    if (looksLikeSchema(o.schema)) { out.schema = o.schema as JsonSchema; break; }
    if (looksLikeSchema(o)) { out.schema = o as JsonSchema; break; }
    if (o.type === undefined && Object.keys(o).length) { out.example = o; break; }   // v1 listings often put the example itself here
  }
  return out;
}

export async function verifyDelivery(response: Response, o: { quote?: unknown; expected?: ExpectedOutput } = {}): Promise<DeliveryCheck> {
  const exp = o.expected ?? expectedOutput(o.quote);
  const status = response.status;
  const fail = (problems: string[], checked: DeliveryCheck["checked"]): DeliveryCheck => ({ ok: false, problems, checked, matchedListing: "no", dataUsable: "no", httpStatus: status });
  const checked: DeliveryCheck["checked"] = exp.example !== undefined ? "example" : exp.schema ? "schema" : "status";
  if (status === 402) return fail(["asked for payment again after paying (402)"], checked);
  if (status < 200 || status >= 300) return fail([`HTTP ${status} after payment`], checked);
  let text = "";
  try { text = await response.clone().text(); } catch { return fail(["couldn't read the response"], checked); }
  const ctype = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!text.trim()) return status === 204 && exp.example === undefined && !exp.schema ? { ok: true, problems: [], checked, matchedListing: "unsure", dataUsable: "unsure", httpStatus: status } : fail(["empty response"], checked);
  let body: unknown = undefined, parsed = false;
  try { body = JSON.parse(text); parsed = true; } catch { /* not JSON */ }
  const wantsJson = exp.json === true || exp.example !== undefined && typeof exp.example !== "string" || !!exp.schema;
  if (!parsed) {
    if (wantsJson || ctype.includes("json")) return fail([`not valid JSON${ctype ? ` (content-type ${ctype.split(";")[0]})` : ""}`], checked);
    return { ok: true, problems: [], checked: "status", matchedListing: "unsure", dataUsable: "unsure", httpStatus: status };
  }
  if (isObj(body) && Object.keys(body).length === 1 && ("error" in body || "errors" in body)) return fail(["the response is only an error message"], checked);
  if (checked === "example") {
    const p = matchesExample(body, exp.example);
    return p.length ? fail(p, checked) : { ok: true, problems: [], checked, matchedListing: "yes", dataUsable: isEmptyResult(body) ? "unsure" : "yes", httpStatus: status };
  }
  if (checked === "schema") {
    const p = validateSchema(body, exp.schema!);
    return p.length ? fail(p.slice(0, 6), checked) : { ok: true, problems: [], checked, matchedListing: "yes", dataUsable: "yes", httpStatus: status };
  }
  return { ok: true, problems: [], checked, matchedListing: "unsure", dataUsable: "unsure", httpStatus: status };
}
