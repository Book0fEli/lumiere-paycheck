// Replies to "Grade dispute" issues automatically: queues a paid re-test on
// Lumière PayCheck and posts the endpoint's current score and failure log.
// Runs via .github/workflows/grade-dispute.yml (no secrets needed).
const API = process.env.PAYCHECK_URL || "https://lumierepaycheck.org";

function endpointFrom(body) {
  // Issue forms render fields as "### Endpoint URL\n\n<value>"
  const m = /###\s*Endpoint URL\s*\n+\s*(\S+)/i.exec(body || "");
  const url = m ? m[1].trim() : null;
  return url && /^https?:\/\//i.test(url) ? url : null;
}

module.exports = async ({ github, context, fetchImpl = fetch }) => {
  const issue = context.payload.issue;
  const isDispute = /^grade dispute/i.test(issue.title || "") || /###\s*Endpoint URL/i.test(issue.body || "");
  if (!isDispute) return "not a dispute";
  const say = (body) => github.rest.issues.createComment({ ...context.repo, issue_number: issue.number, body });
  const url = endpointFrom(issue.body);
  if (!url) {
    await say("Thanks for the report! I couldn't find an endpoint URL in this issue. Please edit it to include the full URL (with the path) under **Endpoint URL**, and a re-test will be queued automatically.");
    return "no url";
  }
  let r, j;
  try {
    r = await fetchImpl(`${API}/v1/dispute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
    j = await r.json();
  } catch (e) {
    await say("Thanks! The automatic check couldn't reach Lumière PayCheck just now; the maintainer has been notified by this issue and will follow up.");
    return "api unreachable";
  }
  if (r.status === 404) {
    await say(`Thanks! \`${url}\` isn't in the monitored catalog, so there's no grade to dispute yet. Endpoints listed in the x402 Bazaar are picked up automatically within a day. Double-check the exact URL, including the path.`);
    return "not monitored";
  }
  await say([
    `Thanks for flagging this. Here's where \`${url}\` stands right now:`,
    "",
    `| Grade | Score | Verdict | 7-day uptime | Paid delivery |`,
    `|---|---|---|---|---|`,
    `| **${j.grade}** | ${j.score ?? "—"} | ${j.verdict} | ${j.uptimePct}% | ${j.delivery} |`,
    "",
    j.queued ? "✅ **A paid re-test has been queued.** Results usually appear within a few hours on the endpoint's page."
             : "ℹ️ A re-test for this endpoint was already requested in the last 24 hours; its result will show on the endpoint's page.",
    "",
    `- Endpoint page, including every failed check with UTC timestamps: ${j.page}`,
    `- Raw failure log: ${j.failures}`,
    "",
    "Checks where our monitor was rate-limited, blocked by a firewall, or couldn't read the payment network never count against an endpoint, and a failed paid check only counts if a re-test about two hours later fails too. If something still looks wrong after the re-test, reply here with timestamps from your own logs.",
    "",
    "_This reply was generated automatically._",
  ].join("\n"));
  try { await github.rest.issues.addLabels({ ...context.repo, issue_number: issue.number, labels: ["grade-dispute"] }); } catch { /* label optional */ }
  return j.queued ? "queued" : "already queued";
};
