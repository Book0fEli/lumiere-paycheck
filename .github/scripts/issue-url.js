// Finding endpoint URLs in seller-test and grade-dispute issues, and retrying issues the bot couldn't read.
//
// The issue forms put the URL under "### Endpoint URL", but issues opened by hand or by an agent through the API
// often don't: "## Endpoint URL", "**Endpoint URL:** <url>", a URL in backticks, <...> or a Markdown link, or only the
// title ("Grade dispute: <url>"). Issues #39, #40 (Nov 10) and #43 (Nov 11) all had the URL and got "couldn't find an
// endpoint URL". Never just the first URL anywhere in the text: that could be a docs link.
const URL_G = /https?:\/\/[^\s<>()`"'\]\[,;]+/gi;
const clean = (u) => u.replace(/[.,;:!?*_]+$/, "");

function urlsFrom(body, title, max = 5) {
  const b = String(body || "");
  // The text after an "Endpoint URL" label (any heading level, bold or plain, with or without a colon), up to the next heading.
  const re = /(?:^|\n)[ \t]*(?:#{1,6}[ \t]*|\*\*|__)?[ \t]*Endpoint URLs?[ \t]*(?:\*\*|__)?[ \t]*:?([\s\S]*?)(?=\n[ \t]*#{1,6}[ \t]|\n[ \t]*(?:\*\*|__)[^\n]*(?:\*\*|__)[ \t]*:?[ \t]*\n|$)/gi;
  const found = [];
  for (let m; (m = re.exec(b)) && found.length < max;) for (const u of (m[1].match(URL_G) || [])) found.push(clean(u));
  if (!found.length && /^(seller test|grade dispute)/i.test(String(title || ""))) for (const u of (String(title).match(URL_G) || [])) found.push(clean(u));
  if (!found.length) found.push(...unlabeled(b, title));
  return [...new Set(found)].slice(0, max);
}

// No "Endpoint URL" label anywhere (Nov 11, #44: the label was missing, and the title named only the host).
// 1) The title names a host ("Grade dispute: api.example.com"): URLs in the text on that host.
// 2) Otherwise, if the text has exactly one URL that isn't ours, GitHub's or a docs/explorer link, that one.
const NOT_ENDPOINTS = /(^|\.)(lumierepaycheck\.org|github\.com|githubusercontent\.com|x402\.org|basescan\.org|solscan\.io|etherscan\.io|docs\.cdp\.coinbase\.com|coinbase\.com|x402scan\.com|x402-list\.com|npmjs\.com)$/i;
function unlabeled(body, title) {
  const all = [...new Set((String(body || "").match(URL_G) || []).map(clean))];
  const host = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
  const named = /^(?:seller test|grade dispute)\s*:?\s*([a-z0-9.-]+\.[a-z]{2,})\b/i.exec(String(title || ""));
  if (named) {
    const onHost = all.filter(u => host(u) === named[1].toLowerCase() && new URL(u).pathname.length > 1 && !/\/\.well-known\//.test(u));
    if (onHost.length) return onHost;
  }
  const candidates = all.filter(u => { const h = host(u); return h && !NOT_ENDPOINTS.test(h) && !/\.well-known\//.test(u); });
  return candidates.length === 1 ? candidates : [];
}

const NO_URL = /couldn't find an endpoint URL/i;
// The bot's last reply was "couldn't find an endpoint URL": the issue text plus what its author wrote since (an edit,
// or a comment with the URL). Returns null when the bot already answered something else, or nothing new was written.
async function pendingNoUrl({ github, repo, issue }) {
  const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: issue.number, per_page: 100 });
  const bot = comments.filter(c => c.user && (c.user.type === "Bot" || /\[bot\]$/.test(c.user.login || "")));
  const last = bot[bot.length - 1];
  if (!last || !NO_URL.test(last.body || "")) return null;
  const author = issue.user && issue.user.login;
  const later = comments.filter(c => c.user && c.user.login === author && Date.parse(c.created_at) > Date.parse(last.created_at)).map(c => c.body || "");
  return { body: [issue.body || "", ...later.map(t => /Endpoint URL/i.test(t) ? t : `### Endpoint URL\n\n${t}`)].join("\n\n"), since: last.created_at };
}

// The "couldn't find" reply: says how to fix it, and that an edit or a comment is picked up within minutes.
const noUrlMessage = (kind) => `Thanks${kind === "seller test" ? "" : " for the report"}! I couldn't find an endpoint URL in this issue. Reply with the full URL (with the path), or edit the issue to put it under **Endpoint URL**, and I'll pick it up within a few minutes.`;

module.exports = { urlsFrom, pendingNoUrl, NO_URL, noUrlMessage };
