// The same response checks Lumière PayCheck's own paid tests use (lumiere-x402-trust src/validate.ts), so an agent's
// verdict on its own paid call matches how PayCheck grades the endpoint.
export interface JsonSchema { type?: string | string[]; properties?: Record<string, JsonSchema>; required?: string[]; items?: JsonSchema; enum?: unknown[]; [k: string]: unknown }

// Deliberately small JSON Schema subset: type, properties, required, items,
// enum. Enough to catch "paid, got an error page / empty object / wrong
// shape", which is the failure sellers and buyers actually care about.
export function validateSchema(value: unknown, schema: JsonSchema, path = "$"): string[] {
  const errors: string[] = [];
  if (!schema || typeof schema !== "object") return errors;   // malformed seller schema: nothing to check
  if (Array.isArray(schema.enum) && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: not one of the allowed values`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => matchesType(value, t))) {
      errors.push(`${path}: expected ${types.join("|")}, got ${typeName(value)}`);
      return errors; // children are meaningless if the type is wrong
    }
  }
  const required = Array.isArray(schema.required) ? schema.required.filter((k: unknown) => typeof k === "string") : [];
  if (schema.properties && typeof schema.properties === "object" && isObject(value)) {
    for (const key of required) {
      if (!(key in value)) errors.push(`${path}.${key}: missing required field`);
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in value && sub && typeof sub === "object") errors.push(...validateSchema((value as any)[key], sub as any, `${path}.${key}`));
    }
  } else if (required.length && isObject(value)) {
    for (const key of required) if (!(key in value)) errors.push(`${path}.${key}: missing required field`);
  }
  if (schema.items && typeof schema.items === "object" && Array.isArray(value)) {
    value.slice(0, 50).forEach((v, i) => errors.push(...validateSchema(v, schema.items!, `${path}[${i}]`)));
  }
  return errors;
}

// Fallback when a seller only published an example. Examples are often
// rough (hand-written or generated), so this checks that the response is the
// kind of thing the example describes, not that it matches field for field:
//   - A response that wraps its content in a common envelope ({ data: … },
//     { result: … }) is compared on what's inside, as well as at the top.
//   - It passes when it carries at least one of the example's fields; a
//     response with none of them (an error object, an empty shell, a
//     different payload) fails. One stray or misnamed field in the seller's
//     example never fails a response that delivers the real data.
const ENVELOPES = ["data", "result", "results", "payload", "response", "output", "body"];
// Any top-level key can wrap the data ("observations", "items", "records"...): the common envelopes first,
// then the other keys holding an object or a list. Error wrappers never count as data.
const NOT_DATA = new Set(["error", "errors", "detail", "message", "warning", "warnings"]);
function wrappers(value: unknown): string[] {
  if (!isObject(value)) return [];
  const others = Object.keys(value).filter(k => !ENVELOPES.includes(k) && !NOT_DATA.has(k.toLowerCase()) && typeof (value as any)[k] === "object" && (value as any)[k] !== null);
  return [...ENVELOPES.filter(k => k in value), ...others];
}
// MCP tools answer { content: [{ type: "text", text }...], isError, structuredContent? }: the tool's output is inside
// (structuredContent, or JSON in a text item). isError: true is the tool saying it failed.
function mcpResult(value: unknown): { isError: boolean; inner: unknown[] } | null {
  if (!isObject(value) || !Array.isArray(value.content) || !value.content.length) return null;
  if (!value.content.every(c => isObject(c) && typeof c.type === "string")) return null;
  if (!("isError" in value) && !("structuredContent" in value)) return null;
  const inner: unknown[] = [];
  if (value.structuredContent !== undefined && value.structuredContent !== null) inner.push(value.structuredContent);
  for (const c of value.content as Record<string, unknown>[]) {
    if (c.type !== "text" || typeof c.text !== "string" || !c.text.trim()) continue;
    try { inner.push(JSON.parse(c.text)); } catch { inner.push(c.text); }
  }
  return { isError: value.isError === true, inner };
}
// An example that only names a generic envelope ({ "result": {} }, { "data": { price: 1 } }) describes what's inside
// it: the inside is what's compared. An empty inside says "there's output" and nothing about its shape.
const PLACEHOLDER = Symbol("placeholder");
function unwrapExample(example: unknown): unknown {
  let e = example;
  for (let i = 0; i < 2 && isObject(e); i++) {
    const keys = Object.keys(e);
    if (keys.length !== 1 || !ENVELOPES.includes(keys[0])) break;
    e = (e as any)[keys[0]];
  }
  if (e === example) return example;
  if (e === null || e === undefined || e === "" || (isObject(e) && !Object.keys(e).length) || (Array.isArray(e) && !e.length)) return PLACEHOLDER;
  return e;
}
/** Something real came back: not empty, not just an error message. */
function hasData(v: unknown): boolean {
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "number" || typeof v === "boolean") return true;
  if (Array.isArray(v)) return v.length > 0;
  if (!isObject(v)) return false;
  const keys = Object.keys(v).filter(k => !NOT_DATA.has(k.toLowerCase()) && k !== "jsonrpc" && k !== "id" && (v as any)[k] !== null && (v as any)[k] !== undefined);
  return keys.length > 0;
}

export function matchesExample(value: unknown, example: unknown): string[] {
  // A null or prose example ("JSON with prices") says there's output, not what shape: nothing to match.
  if (example === null || typeof example === "string") return [];
  const mcp = mcpResult(value) ?? (isObject(value) && "jsonrpc" in value ? mcpResult(value.result) : null);
  if (mcp?.isError) return ["the tool answered with an error (isError: true)"];
  const first = matchesExampleCore(value, example);
  if (!first.length) return [];
  const values = [value, ...(mcp?.inner ?? [])];
  const inner = unwrapExample(example);
  if (inner === PLACEHOLDER) return (mcp ? mcp.inner.some(hasData) : hasData(value)) ? [] : ["the response is empty or only an error message"];
  // A plain value inside the envelope ({ "result": "x" }) is a value, not prose: only the example as written counts then.
  const examples = inner === example || (inner !== null && typeof inner !== "object") ? [example] : [example, inner];
  for (const v of values) for (const e of examples) if (!matchesExampleCore(v, e).length) return [];
  return first;
}

function matchesExampleCore(value: unknown, example: unknown): string[] {
  if (example === null || typeof example === "string") return [];
  if (isEmptyResult(value)) return [];   // an honest "no results" for our test input isn't bad data
  const candidates: unknown[] = [value];
  for (const k of wrappers(value)) candidates.push((value as any)[k]);
  if (isObject(example)) {
    const keys = Object.keys(example);
    if (!keys.length) return candidates.some(isObject) ? [] : [`expected object like the example, got ${typeName(value)}`];
    for (const c of candidates) if (isObject(c) && keys.some(k => k in c)) return [];
    // A list of the items the example describes (the listing showed one item) delivers the data too.
    for (const c of candidates) if (Array.isArray(c) && c.length && isObject(c[0]) && keys.some(k => k in (c[0] as any))) return [];
    // The listing wraps the data ({ results: [...], count } or { quote: {...} }) and the response is the bare list.
    if (bareListOfWrapped(value, example)) return [];
    if (!candidates.some(isObject)) return [`expected object like the example, got ${typeName(value)}`];
    return [`none of the example's fields (${keys.slice(0, 6).join(", ")}) in the response, at the top level or inside any wrapper`];
  }
  const want = typeName(example);
  const same = (a: string, b: string) => a === b || (a === "integer" && b === "number") || (a === "number" && b === "integer");
  if (candidates.some(c => same(typeName(c), want))) return [];
  return [`expected ${want} like the example, got ${typeName(value)}`];
}

// The example is an object holding the data under one key (a list of items, or one item); the response is a bare
// list of those items. Returns that key, or null. Items must share fields with the example's item (or, for plain
// values, have the same type), so a list of unrelated things never passes.
function bareListOfWrapped(value: unknown, example: Record<string, unknown>): string | null {
  if (!Array.isArray(value) || !value.length) return null;
  const first = value[0];
  for (const [k, v] of Object.entries(example)) {
    const item = Array.isArray(v) ? v[0] : isObject(v) ? v : undefined;
    if (item === undefined) continue;
    if (isObject(item) && isObject(first) && Object.keys(item).some(f => f in first)) return k;
    if (Array.isArray(v) && !isObject(item) && item !== null && typeName(item) === typeName(first)) return k;
  }
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}
function matchesType(v: unknown, t: string): boolean {
  const n = typeName(v);
  return n === t || (t === "number" && n === "integer");
}

// An empty list, at the top level or inside a common envelope: a valid "no results" answer.
export function isEmptyResult(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (isObject(value)) return ENVELOPES.some(e => Array.isArray((value as any)[e]) && (value as any)[e].length === 0) && !("error" in value);
  return false;
}
