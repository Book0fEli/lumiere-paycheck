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
