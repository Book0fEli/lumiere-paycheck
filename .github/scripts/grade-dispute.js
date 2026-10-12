// Replies to "Grade dispute" issues automatically: queues a paid re-test on
// Lumière PayCheck and posts each endpoint's current score.
// Runs via .github/workflows/grade-dispute.yml (no secrets needed).
const API = process.env.PAYCHECK_URL || "https://lumierepaycheck.org";
const MAX_URLS = 5;

// Issue forms render fields as "### Endpoint URL\n\n<value>". Sellers sometimes list several endpoints, separated by
// commas, spaces or new lines: take each one (up to 5), without trailing punctuation.
function endpointsFrom(body) {
  const m = /###\s*Endpoint URL\s*\n+([\s\S]*?)(?:\n###|$)/i.exec(body || "");
  if (!m) return [];
  const found = (m[1].match(/https?:\/\/[^\s,;<>"'`)\]]+/gi) || []).map(u => u.replace(/[.,;:!?]+$/, ""));
  return [...new Set(found)].slice(0, MAX_URLS);
}

module.exports = async ({ github, context, fetchImpl = fetch }) => {
  const issue = context.payload.issue;
  // Seller-funded test requests share the "Endpoint URL" field; seller-test.js handles those.
  if (/^seller test/i.test(issue.title || "") || (issue.labels || []).some(l => (l.name || l) === "seller-test")) return "seller test";
  const isDispute = /^grade dispute/i.test(issue.title || "") || /###\s*Endpoint URL/i.test(issue.body || "");
  if (!isDispute) return "not a dispute";
  const say = (body) => github.rest.issues.createComment({ ...context.repo, issue_number: issue.number, body });
  const urls = endpointsFrom(issue.body);
  if (!urls.length) {
    await say("Thanks for the report! I couldn't find an endpoint URL in this issue. Please edit it to include the full URL (with the path) under **Endpoint URL**, and a re-test will be queued automatically.");
    return "no url";
  }

  const results = [];
  for (const url of urls) {
    try {
      const r = await fetchImpl(`${API}/v1/dispute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
      results.push({ url, status: r.status, j: await r.json().catch(() => ({})) });
    } catch {
      results.push({ url, status: 0, j: {} });
    }
  }
  if (results.every(x => x.status === 0)) {
    await say("Thanks! The automatic check couldn't reach Lumière PayCheck just now; the maintainer has been notified by this issue and will follow up.");
    return "api unreachable";
  }
  const monitored = results.filter(x => x.status !== 404 && x.status !== 0);
  const missing = results.filter(x => x.status === 404);
  if (!monitored.length) {
    await say(`Thanks! ${missing.map(x => `\`${x.url}\``).join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} in the monitored catalog, so there's no grade to dispute yet. Endpoints listed in the x402 Bazaar are picked up automatically within a day. Double-check the exact URL, including the path.`);
    return "not monitored";
  }

  const one = monitored.length === 1;
  const lines = [
    one ? `Thanks for flagging this. Here's where \`${monitored[0].url}\` stands right now:` : `Thanks for flagging these. Here's where each endpoint stands right now:`,
    "",
    `| Endpoint | Grade | Score | Verdict | 7-day uptime | Paid delivery | Re-test |`,
    `|---|---|---|---|---|---|---|`,
    ...monitored.map(({ url, j }) => `| [${url.replace(/^https?:\/\//, "")}](${j.page || `${API}/e?url=${encodeURIComponent(url)}`}) | **${j.grade ?? "?"}** | ${j.score ?? "—"} | ${j.verdict ?? "—"} | ${j.uptimePct ?? "—"}% | ${j.delivery ?? "—"} | ${j.queued ? "✅ queued" : "already requested in the last 24h"} |`),
    "",
    "Results usually appear within a few hours. Each endpoint's page shows its **Recent paid tests** (what came back, whether money was taken, and whether it counted) and its free checks with UTC timestamps.",
  ];
  if (missing.length) lines.push("", `Not in the monitored catalog (no grade yet): ${missing.map(x => `\`${x.url}\``).join(", ")}.`);
  if (results.some(x => x.status === 0)) lines.push("", "Some endpoints couldn't be checked just now; the maintainer will follow up.");
  lines.push(
    "",
    "Checks where our monitor was rate-limited, blocked by a firewall, or couldn't read the payment network never count against an endpoint, and a failed paid check only counts if a re-test about two hours later fails too. If something still looks wrong after the re-test, reply here with timestamps from your own logs.",
    "",
    "_This reply was generated automatically._",
  );
  await say(lines.join("\n"));
  try { await github.rest.issues.addLabels({ ...context.repo, issue_number: issue.number, labels: ["grade-dispute"] }); } catch { /* label optional */ }
  return monitored.some(x => x.j.queued) ? "queued" : "already queued";
};

module.exports.endpointsFrom = endpointsFrom;

// ---------------------------------------------------------------------------------------------------------------
// Follow-up (scheduled): once the queued re-test has run, post the result on the dispute and close it if resolved.
// Progress is tracked with a label so nothing is posted twice: grade-dispute -> grade-dispute:answered.
// Skipped: issues the maintainer has already replied on (they're handling it), and issues older than 14 days.
const ORDER = { A: 5, B: 4, C: 3, D: 2, F: 1 };
const hasLabel = (issue, name) => (issue.labels || []).some(l => (l.name || l) === name);
const short = (url) => url.replace(/^https?:\/\//, "");
const OUTCOME = {
  delivered: "✅ delivered",
  suspect: "⚠️ didn't deliver (first failure; confirming)",
  bad_response: "❌ didn't deliver",
  mismatch: "⚠️ our request didn't match what the endpoint expects (not counted)",
};

// Grades from the bot's first reply: rows like "| [host/path](...) | **B** | 85 |" (or the older one-endpoint table).
function gradesBefore(text, urls) {
  const out = {};
  for (const url of urls) {
    const esc = short(url).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`\\|\\s*\\[?\`?${esc}\`?\\]?(?:\\([^)]*\\))?\\s*\\|\\s*\\*\\*([A-F?])\\*\\*\\s*\\|\\s*(\\d+|—)`).exec(text || "");
    if (m) out[url] = { grade: m[1], score: m[2] };
  }
  if (urls.length === 1 && !out[urls[0]]) {
    const m = /\|\s*\*\*([A-F])\*\*\s*\|\s*(\d+|—)/.exec(text || "");
    if (m) out[urls[0]] = { grade: m[1], score: m[2] };
  }
  return out;
}

async function followUp({ github, repo, issue, fetchImpl, now }) {
  const n = issue.number;
  const urls = endpointsFrom(issue.body);
  if (!urls.length) return "no url";
  const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: n, per_page: 100 });
  const owner = repo.owner.toLowerCase();
  if (comments.some(c => (c.user?.login || "").toLowerCase() === owner)) return "maintainer is handling it";
  const first = comments.find(c => c.user?.type === "Bot" && /Here's where/.test(c.body || ""));
  const before = gradesBefore(first?.body, urls);

  const opened = Date.parse(issue.created_at);
  const rows = [], blocked = [];
  let waiting = false;
  for (const url of urls) {
    let r, j;
    try { r = await fetchImpl(`${API}/v1/dispute?url=${encodeURIComponent(url)}`, { headers: { accept: "application/json" } }); j = await r.json(); }
    catch { return "api unreachable"; }
    if (r.status === 404) continue;                       // not monitored: the first reply already said so
    if (!r.ok || typeof j.done !== "boolean") return "api not ready";
    const asked = j.request && Date.parse(j.request.requestedAt) >= opened - 24 * 3600_000;
    if (!asked) continue;                                 // no re-test was queued for this issue (the first reply said why)
    if (!j.done) { waiting = true; if (j.blocked) blocked.push({ url, b: j.blocked }); continue; }
    const ran = j.lastPaidTest && Date.parse(j.lastPaidTest.at) >= Date.parse(j.request.requestedAt);
    rows.push({ url, j, outcome: ran ? j.lastPaidTest.outcome : null, before: before[url] });
  }
  if (now - opened > 14 * 86400_000) return "too old";
  if (waiting) {
    // A free re-test blocked for days by the weekly wallet limit: say so once, with a way to get it tested now.
    if (blocked.length && !hasLabel(issue, "grade-dispute:blocked")) {
      const lines = [];
      for (const { url, b } of blocked) {
        lines.push(`⏸️ **The free re-test for \`${short(url)}\` ${b.reason === "price_above_test_cap" ? "can't run" : "is waiting"}.** ${b.message}`, "");
        if (b.fund) lines.push(
          `**To get it tested now,** fund one paid test at the endpoint's own price (**${b.fund.price}** in USDC on Base). It's paid to our tester wallet and held for this test; the tester pays your endpoint that same amount, so the money goes back to your payout wallet, and anything the test doesn't spend is returned to you. Send one x402 payment with any x402 client:`,
          "", "```", `POST ${b.fund.payUrl}&issue=${n}`, "```", "",
          "The test runs at a random time within about 3 hours of funding. I'll post the result here, and close this issue if the grade is fixed.", "");
        else if (b.fundUnavailable) lines.push(`A funded test isn't available for this endpoint (${String(b.fundUnavailable).replace(/^[a-z_]+: /, "")}), so the free re-test will run as soon as the weekly total allows.`, "");
      }
      if (blocked.some(x => x.b.reason === "wallet_weekly_cap")) lines.push("If you don't fund one, the free re-test still runs on its own once the limit allows, and the result is posted here.", "");
      else lines.push("This issue stays open until a funded test runs; its result is posted here automatically.", "");
      lines.push("_This reply was generated automatically._");
      await github.rest.issues.createComment({ ...repo, issue_number: n, body: lines.join("\n") });
      await github.rest.issues.addLabels({ ...repo, issue_number: n, labels: ["grade-dispute:blocked"] }).catch(() => {});
      return "blocked: offered a funded test";
    }
    return "re-test still running";
  }
  if (!rows.length) return "nothing to report";

  const delivered = rows.every(x => x.outcome === "delivered");
  const fixed = delivered && rows.every(x => x.j.grade === "A" || (x.before && ORDER[x.j.grade] > (ORDER[x.before.grade] || 0)));
  const one = rows.length === 1;
  const lines = [
    fixed ? `✅ **The re-test is done${one ? "" : " for every endpoint"} and the grade has been updated.**`
      : delivered && rows.some(x => x.j.listingCapped) ? "The re-test delivered, but the response still doesn't match the example in the listing, so the grade stays capped at B. The endpoint page shows which fields differ."
      : delivered ? "The re-test delivered, but the grade didn't change. The maintainer will take a look."
      : `The re-test is done. Here's what it found:`,
    "",
    "| Endpoint | Grade before | Grade now | Score | Verdict | Re-test |",
    "|---|---|---|---|---|---|",
    ...rows.map(({ url, j, outcome, before }) => `| [${short(url)}](${j.page}) | ${before ? before.grade : "—"} | **${j.grade}** | ${j.score ?? "—"} | ${j.verdict ?? "—"} | ${outcome ? (OUTCOME[outcome] || outcome) : "couldn't run (not counted)"} |`),
    "",
  ];
  if (rows.some(x => !x.outcome)) lines.push("A re-test that couldn't run (endpoint unreachable, price changed, or our daily test budget) never counts against the grade.", "");
  lines.push(fixed ? "Closing this out. If anything looks off again, open a new dispute anytime."
                   : "If you fix something on your side, reply here and the maintainer will queue another re-test.",
             "", "_This reply was generated automatically._");
  await github.rest.issues.createComment({ ...repo, issue_number: n, body: lines.join("\n") });
  await github.rest.issues.addLabels({ ...repo, issue_number: n, labels: ["grade-dispute:answered"] }).catch(() => {});
  if (fixed) await github.rest.issues.update({ ...repo, issue_number: n, state: "closed", state_reason: "completed" });
  return fixed ? "answered and closed" : "answered";
}

module.exports.sweep = async ({ github, context, fetchImpl = fetch, now = Date.now() }) => {
  const repo = context.repo;
  const issues = await github.paginate(github.rest.issues.listForRepo, { ...repo, state: "open", labels: "grade-dispute", per_page: 100 });
  const done = [];
  for (const issue of issues) {
    if (issue.pull_request || hasLabel(issue, "grade-dispute:answered")) continue;
    try { done.push(`#${issue.number}: ${await followUp({ github, repo, issue, fetchImpl, now })}`); }
    catch (e) { done.push(`#${issue.number}: error ${e?.message || e}`); }
  }
  return `${issues.length} open. ${done.join("; ")}`;
};
module.exports.gradesBefore = gradesBefore;
