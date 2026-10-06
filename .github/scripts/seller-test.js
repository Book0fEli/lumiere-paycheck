// Seller-funded tests, run entirely by this bot and the Lumière PayCheck API (no secrets needed):
//   onOpened: a "Seller test" issue was filed -> check eligibility, post the price and payment link.
//   sweep (every 15 min): for open seller-test issues, post "funding received", then the result, then close.
// Progress is tracked with labels so nothing is posted twice:
//   seller-test -> seller-test:funded -> seller-test:done (closed) | seller-test:refund -> (closed when refunded)
const API = process.env.PAYCHECK_URL || "https://lumierepaycheck.org";
const DOCS = "https://lumierepaycheck.org/docs/sellers#6-seller-funded-tests";

const isSellerTest = (issue) => /^seller test/i.test(issue.title || "") || (issue.labels || []).some(l => (l.name || l) === "seller-test");
function endpointFrom(body) {
  const m = /###\s*Endpoint URL\s*\n+\s*(\S+)/i.exec(body || "");
  const url = m ? m[1].trim() : null;
  return url && /^https?:\/\//i.test(url) ? url : null;
}
const getJson = async (fetchImpl, path) => { const r = await fetchImpl(`${API}${path}`, { headers: { accept: "application/json" } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const hasLabel = (issue, name) => (issue.labels || []).some(l => (l.name || l) === name);

function payInstructions(q, issueNumber) {
  const payUrl = `${q.payUrl}&issue=${issueNumber}`;
  return [
    `**Price:** ${q.price} in USDC on Base (your endpoint's own price). **How to pay:** send one x402 payment to:`,
    "",
    "```",
    `POST ${payUrl}`,
    "```",
    "",
    "Any x402 client works. For example, with Node.js (uses a wallet that holds the USDC; the key stays on your machine):",
    "",
    "```bash",
    "npm i @x402/fetch @x402/evm viem",
    `PRIVATE_KEY=0x... node --input-type=module -e '`,
    `import { wrapFetchWithPayment, x402Client } from "@x402/fetch";`,
    `import { registerExactEvmScheme } from "@x402/evm/exact/client";`,
    `import { privateKeyToAccount } from "viem/accounts";`,
    `const client = registerExactEvmScheme(new x402Client(), { signer: privateKeyToAccount(process.env.PRIVATE_KEY) });`,
    `client.setSpendControls({ maxAmountPerPayment: "${q.price}" });`,
    `const res = await wrapFetchWithPayment(fetch, client)("${payUrl}", { method: "POST" });`,
    `console.log(res.status, await res.text());'`,
    "```",
    "",
    "A `201` response means it's funded. You don't need to do anything else: this issue updates on its own.",
  ].join("\n");
}

exports.onOpened = async ({ github, context, fetchImpl = fetch }) => {
  const issue = context.payload.issue;
  if (!isSellerTest(issue)) return "not a seller test";
  const repo = context.repo, n = issue.number;
  const say = (body) => github.rest.issues.createComment({ ...repo, issue_number: n, body });
  const close = () => github.rest.issues.update({ ...repo, issue_number: n, state: "closed", state_reason: "not_planned" });
  try { await github.rest.issues.addLabels({ ...repo, issue_number: n, labels: ["seller-test"] }); } catch { /* optional */ }
  const url = endpointFrom(issue.body);
  if (!url) { await say("Thanks! I couldn't find an endpoint URL in this issue. Please edit it to include the full URL (with the path) under **Endpoint URL**, then open a new seller test."); return "no url"; }
  let q;
  try { q = await getJson(fetchImpl, `/v1/seller-test/quote?url=${encodeURIComponent(url)}`); }
  catch { await say("Thanks! The automatic check couldn't reach Lumière PayCheck just now. Please try again in a few minutes by opening a new seller test."); return "api unreachable"; }
  const b = q.body || {};
  if (!b.eligible) {
    const why = String(b.reason || "not eligible");
    if (/^already_funded/.test(why)) {
      await say(`A funded test for \`${url}\` is already queued, so there's nothing to pay. Its result will be posted on the issue it was funded from, and on the endpoint's page: ${API}/e?url=${encodeURIComponent(url)}`);
    } else {
      await say(`Thanks! A funded test isn't available for \`${url}\` right now:\n\n> ${why.replace(/^[a-z_]+: /, "")}\n\nEndpoint page: ${API}/e?url=${encodeURIComponent(url)}\n\n_This reply was generated automatically._`);
    }
    await close();
    return `not eligible: ${why.split(":")[0]}`;
  }
  await say([
    `Thanks for verifying \`${url}\`. It costs more than our tester pays on its own, so here's how to fund one paid test of it.`,
    "",
    payInstructions(b, n),
    "",
    "**What happens next**",
    "- Our tester pays your endpoint the same price at a random time within about 3 hours, so the money goes back to your payout wallet.",
    "- The grade comes only from what the test finds, pass or fail. The endpoint page notes that the test was funded by the seller.",
    "- If the test can't run within 3 days (endpoint down, or the price went up), the funding is refunded automatically to the wallet that paid.",
    "- If no payment arrives within 7 days, this issue closes on its own.",
    "",
    `More: ${DOCS}`,
    "",
    "_This reply was generated automatically._",
  ].join("\n"));
  return "instructions posted";
};

function resultComment(t, score) {
  const passed = t.outcome === "delivered";
  const first = t.outcome === "suspect";
  const lines = [
    passed ? `✅ **The funded test delivered.** \`${t.url}\` was paid ${t.amount} and returned a valid response.`
      : first ? `⚠️ **The funded test didn't deliver this time** (first failure, not counted against the grade yet).`
      : `❌ **The funded test didn't deliver.**`,
    "",
    `| Result | Grade before | Grade now | Score | Verdict |`,
    `|---|---|---|---|---|`,
    `| ${t.outcome} | ${t.gradeBefore ?? "—"} | **${score?.grade ?? "—"}** | ${score?.score ?? "—"} | ${score?.verdict ?? "—"} |`,
    "",
  ];
  if (t.detail) lines.push(`Details: ${String(t.detail).slice(0, 400)}`, "");
  if (first) lines.push("A first failure only counts if a second test within 24 hours fails too. If you fix the issue, you can fund another test right away by opening a new seller test; if it delivers, the grade updates.", "");
  lines.push(`Endpoint page (with the full test history): ${t.page}`, "", "_This reply was generated automatically._");
  return lines.join("\n");
}

exports.sweep = async ({ github, context, fetchImpl = fetch }) => {
  const repo = context.repo;
  const issues = await github.paginate(github.rest.issues.listForRepo, { ...repo, state: "open", labels: "seller-test", per_page: 100 });
  let updated = 0;
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const n = issue.number;
    const say = (body) => github.rest.issues.createComment({ ...repo, issue_number: n, body });
    const label = (name) => github.rest.issues.addLabels({ ...repo, issue_number: n, labels: [name] }).catch(() => {});
    const close = (reason = "completed") => github.rest.issues.update({ ...repo, issue_number: n, state: "closed", state_reason: reason });
    let tests;
    try { tests = (await getJson(fetchImpl, `/v1/seller-tests?issue=${n}`)).body?.tests || []; } catch { continue; }
    const t = tests[tests.length - 1];
    if (!t) {
      if (Date.now() - Date.parse(issue.created_at) > 7 * 86400_000) {
        await say("No payment arrived within 7 days, so I'm closing this. Open a new seller test whenever you're ready.\n\n_This reply was generated automatically._");
        await close("not_planned"); updated++;
      }
      continue;
    }
    if (!hasLabel(issue, "seller-test:funded")) {
      await say(`💰 **Funding received** (${t.amount}${t.fundTx ? `, tx [\`${String(t.fundTx).slice(0, 10)}…\`](https://basescan.org/tx/${t.fundTx})` : ""}). The test is scheduled at a random time within about 3 hours. I'll post the result here.`);
      await label("seller-test:funded"); updated++;
    }
    if (t.status === "done" && !hasLabel(issue, "seller-test:done")) {
      let score = null;
      try { score = (await getJson(fetchImpl, `/v1/score?url=${encodeURIComponent(t.url)}`)).body; } catch { /* optional */ }
      await say(resultComment(t, score));
      await label("seller-test:done"); await close(); updated++;
    } else if (t.status === "refund_due" && !hasLabel(issue, "seller-test:refund")) {
      await say(`The test couldn't run after ${t.attempts} attempts over 3 days (last reason: ${t.lastError ?? "unknown"}). Your funding of ${t.amount} is being refunded to the wallet that paid it; I'll post the refund transaction here.`);
      await label("seller-test:refund"); updated++;
    } else if (t.status === "refunded") {
      await say(`↩️ **Refunded** ${t.amount}${t.refundTx ? ` (tx [\`${String(t.refundTx).slice(0, 10)}…\`](https://basescan.org/tx/${t.refundTx}))` : ""}. Once the endpoint is reachable at its listed price, you can open a new seller test.\n\n_This reply was generated automatically._`);
      await close("not_planned"); updated++;
    }
  }
  return `${issues.length} open, ${updated} updated`;
};
