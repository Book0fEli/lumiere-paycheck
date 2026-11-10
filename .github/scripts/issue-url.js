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
  return [...new Set(found)].slice(0, max);
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

module.exports = { urlsFrom, pendingNoUrl, NO_URL };
