// GitHub PRs for Mota Editor — your open pull requests as a sidebar
// panel, grouped by what actually needs you, each badged with its CI
// status. Plain Node (18+, for fetch), no dependencies: one JSON object
// per stdin line in, one per stdout line out (MXP, docs/EXTENSIONS.md).
//
// Credentials, in order: the `gh` CLI if it is installed and logged in
// (zero setup — this is the normal path), then GITHUB_TOKEN / GH_TOKEN,
// then a {"token": "ghp_…"} in <dataDir>/config.json. The only file this
// extension writes is that same config.json, and only to remember which
// repositories you hid.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const GITHUB_GRAPHQL = "https://api.github.com/graphql";
/** Panel/action budget is 30 s; leave the host room to answer. */
const FETCH_TIMEOUT_MS = 20_000;
const MAX_PULL_REQUESTS = 50;
/** GraphQL caps a connection page at 100. */
const MAX_CONTEXTS = 100;
/** Only read when a preview modal is opened, for one pull request — a
 *  full page, so the announcement is found however long the thread got. */
const MAX_COMMENTS = 100;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyError = (id, message) =>
  send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
const log = (message) => send({ jsonrpc: "2.0", method: "host/log", params: { message } });

let dataDir = "";
/** itemId → the pull request it was built from, so opening one costs no
 *  round trip. Rebuilt on every load; a miss re-fetches. */
let pullRequestsById = new Map();
/** The last answer from GitHub, so hiding and unhiding a repo is a
 *  re-render rather than another round trip. */
let lastPullRequests = null;
/** Item id prefix for the rows in the "Hidden repositories" group —
 *  keeps them apart from pull requests in the one id space we get. */
const HIDDEN_PREFIX = "hidden:";

// Exiting the moment `shutdown` arrives would drop replies still being
// built (the host batches stdin) — drain in-flight requests first, with
// a hard stop so a hung fetch cannot outlive the host's kill window.
let inFlight = 0;
let shuttingDown = false;
const maybeExit = () => {
  if (shuttingDown && inFlight === 0) process.exit(0);
};

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  inFlight += 1;
  handle(msg)
    .catch((e) => {
      if (msg.id !== undefined) replyError(msg.id, String(e && e.message ? e.message : e));
      log(`unhandled: ${e && e.stack ? e.stack : e}`);
    })
    .finally(() => {
      inFlight -= 1;
      maybeExit();
    });
});

async function handle(msg) {
  if (msg.method === "initialize") {
    dataDir = (msg.params && msg.params.dataDir) || "";
    reply(msg.id, { protocolVersion: 1 });
  } else if (msg.method === "panel/load") {
    reply(msg.id, { view: await buildView() });
  } else if (msg.method === "panel/action") {
    reply(msg.id, await handleAction(msg.params));
  } else if (msg.method === "ping") {
    reply(msg.id, {});
  } else if (msg.method === "shutdown") {
    shuttingDown = true;
    setTimeout(() => process.exit(0), 2000).unref();
  } else if (msg.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `Unknown method: ${msg.method}` },
    });
  }
}

// ---- The panel ----

/** Asks GitHub. Only a real load or an explicit refresh should do this. */
async function buildView() {
  try {
    lastPullRequests = await fetchOpenPullRequests();
  } catch (e) {
    if (e && e.notConnected) return notConnectedView(e.message);
    throw e;
  }
  return renderView();
}

/** Re-renders the last answer — what hiding a repo needs, since nothing
 *  on GitHub changed. Falls back to a fetch before the first load. */
async function rebuildView() {
  return lastPullRequests === null ? buildView() : renderView();
}

function renderView() {
  const pullRequests = lastPullRequests || [];
  pullRequestsById = new Map(pullRequests.map((pr) => [itemId(pr), pr]));
  const hidden = hiddenRepos();
  const visible = pullRequests.filter(
    (pr) => !hidden.includes(pr.repository.nameWithOwner),
  );
  const groups = groupByAttention(visible);
  if (hidden.length > 0) groups.push(hiddenGroup(hidden, pullRequests));
  return {
    groups,
    emptyText:
      hidden.length > 0
        ? "Every open pull request you have is in a hidden repository."
        : "No open pull requests authored by you. Nothing to chase.",
  };
}

/** Hidden repos live at the bottom, each with a delete button that puts
 *  it back — right-click is the shortcut, this is the way out. */
function hiddenGroup(hidden, pullRequests) {
  return {
    title: "Hidden repositories",
    items: hidden.map((repo) => {
      const count = pullRequests.filter(
        (pr) => pr.repository.nameWithOwner === repo,
      ).length;
      return {
        id: `${HIDDEN_PREFIX}${repo}`,
        title: repo,
        subtitle: `${count} open pull request${count === 1 ? "" : "s"} hidden`,
        removable: true,
        menu: [{ id: "show-repo", label: `Show ${repo} again` }],
      };
    }),
  };
}

async function handleAction(params) {
  const { action, itemId: id, value } = params || {};
  if (action === "button" && id === "retry") return { view: await buildView() };
  if (!id) return {};

  const hiddenRepo = id.startsWith(HIDDEN_PREFIX) ? id.slice(HIDDEN_PREFIX.length) : null;

  // "Hide this repository" from a pull request's menu; the reverse from
  // the bottom group's menu or its delete button.
  if (hiddenRepo && (action === "menu" || action === "remove")) {
    setHiddenRepos(hiddenRepos().filter((repo) => repo !== hiddenRepo));
    log(`showing ${hiddenRepo} again`);
    return { view: await rebuildView() };
  }
  // Switched on the entry's own id, never on "it was a menu action":
  // a second entry must not inherit the first one's behaviour.
  if (action === "menu") {
    const pullRequest = pullRequestsById.get(id);
    if (!pullRequest) return {};
    if (value === "open-preview") {
      const preview = previewOf(pullRequest);
      return preview ? { detail: await previewDetail(pullRequest, preview) } : {};
    }
    if (value === "hide-repo") {
      const repo = pullRequest.repository.nameWithOwner;
      setHiddenRepos([...hiddenRepos(), repo].sort());
      log(`hiding ${repo}`);
      return { view: await rebuildView() };
    }
    return {};
  }

  if (action === "open") {
    if (hiddenRepo) return { detail: hiddenDetail(hiddenRepo) };
    if (pullRequestsById.size === 0) await buildView();
    const pullRequest = pullRequestsById.get(id);
    if (pullRequest) return { detail: detailOf(pullRequest) };
  }
  return {};
}

function hiddenDetail(repo) {
  return {
    title: repo,
    subtitle: "Hidden",
    fields: [{ label: "Status", value: "Its pull requests are hidden from this panel." }],
    body: "Right-click the row, or press its delete button, to show this repository again.",
    url: `https://github.com/${repo}`,
  };
}

function notConnectedView(reason) {
  return {
    groups: [],
    buttons: [{ id: "retry", label: "Retry" }],
    emptyText: `${reason} Run \`gh auth login\` in a terminal, or set GITHUB_TOKEN, or put {"token": "ghp_…"} in ${configPath()} — then press Retry.`,
  };
}

// ---- Talking to GitHub ----

const PULL_REQUEST_QUERY = `query($first: Int!, $contexts: Int!) {
  viewer {
    pullRequests(states: OPEN, first: $first, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title url isDraft updatedAt headRefName baseRefName
        mergeable reviewDecision
        repository { nameWithOwner }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: $contexts) {
                  nodes {
                    __typename
                    ... on CheckRun { name conclusion status detailsUrl title summary }
                    ... on StatusContext { context state targetUrl }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

async function fetchOpenPullRequests() {
  const body = {
    query: PULL_REQUEST_QUERY,
    variables: { first: MAX_PULL_REQUESTS, contexts: MAX_CONTEXTS },
  };
  const token = readToken();
  const data = token ? await graphqlOverHttp(token, body) : await graphqlOverGhCli(body);
  return data.viewer.pullRequests.nodes;
}

/** A token from the environment or config.json — never from `gh`, whose
 *  own auth we use by shelling out rather than by reading its store. */
function readToken() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const stored = readConfig().token;
  return typeof stored === "string" && stored.trim() ? stored.trim() : null;
}

function configPath() {
  return path.join(dataDir || "<dataDir>", "config.json");
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

/** Merges, so writing the hidden list never eats a hand-placed token. */
function saveConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`);
}

function hiddenRepos() {
  const stored = readConfig().hiddenRepos;
  return Array.isArray(stored) ? stored.filter((repo) => typeof repo === "string") : [];
}

function setHiddenRepos(repos) {
  saveConfig({ hiddenRepos: [...new Set(repos)] });
}

async function graphqlOverHttp(token, body) {
  const response = await fetch(GITHUB_GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "mota-github-prs",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    throw notConnected("GitHub rejected the token.");
  }
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}.`);
  return unwrapGraphql(await response.json());
}

/** `gh api graphql --input -` — reuses whatever the CLI is logged in as,
 *  so the common case needs no token anywhere. */
function graphqlOverGhCli(body) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", ["api", "graphql", "--input", "-"], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("gh took too long to answer."));
    }, FETCH_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(
        e.code === "ENOENT"
          ? notConnected("The GitHub CLI (`gh`) is not installed, and no token is configured.")
          : e,
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.trim() || `gh exited with code ${code}`;
        log(`gh failed: ${detail}`);
        return reject(
          /auth|logged in|token/i.test(detail)
            ? notConnected("The GitHub CLI is installed but not logged in.")
            : new Error(detail),
        );
      }
      try {
        resolve(unwrapGraphql(JSON.parse(stdout)));
      } catch (e) {
        reject(new Error(`Could not read gh's answer: ${e.message}`));
      }
    });
    child.stdin.end(JSON.stringify(body));
  });
}

function unwrapGraphql(payload) {
  if (payload.errors && payload.errors.length > 0) {
    throw new Error(payload.errors[0].message || "GitHub returned an error.");
  }
  // Only that there IS data: this carries the viewer's pull requests for
  // one query and a single repository's comments for the other.
  if (!payload.data) throw new Error("GitHub returned no data.");
  return payload.data;
}

/** Marks the "you are not signed in" case, which is a view rather than
 *  an error — the panel explains itself instead of showing a stack. */
function notConnected(message) {
  const error = new Error(message);
  error.notConnected = true;
  return error;
}

// ---- Reading the CI rollup ----

/** Every check on the head commit, flattened across the two shapes
 *  GitHub uses (Actions-style CheckRun, legacy StatusContext). */
function checksOf(pullRequest) {
  const commit = ((pullRequest.commits || {}).nodes || [])[0];
  const rollup = commit && commit.commit && commit.commit.statusCheckRollup;
  const nodes = (rollup && rollup.contexts && rollup.contexts.nodes) || [];
  return nodes.flatMap((node) => {
    if (node.__typename === "CheckRun") {
      return [
        {
          name: node.name,
          url: node.detailsUrl,
          state: checkRunState(node),
        },
      ];
    }
    if (node.__typename === "StatusContext") {
      return [
        {
          name: node.context,
          url: node.targetUrl,
          state: statusContextState(node.state),
        },
      ];
    }
    return [];
  });
}

function checkRunState(node) {
  if (node.status !== "COMPLETED") return "running";
  if (node.conclusion === "SUCCESS") return "passed";
  if (node.conclusion === "SKIPPED" || node.conclusion === "NEUTRAL") return "skipped";
  return "failed";
}

function statusContextState(state) {
  if (state === "SUCCESS") return "passed";
  if (state === "PENDING" || state === "EXPECTED") return "running";
  return "failed";
}

function tally(checks) {
  const counts = { passed: 0, failed: 0, running: 0, skipped: 0 };
  for (const check of checks) counts[check.state] += 1;
  return counts;
}

/** The badge is the whole CI story in one glance-sized string, plus the
 *  tone the host colours it with (red/amber/green from the live theme).
 *  The glyph stays in the text so the state survives without colour. */
function ciBadge(counts, total) {
  if (total === 0) return {};
  if (counts.failed > 0) {
    return { badge: `✗ ${counts.failed} of ${total}`, badgeTone: "danger" };
  }
  if (counts.running > 0) {
    return { badge: `◐ ${counts.running} running`, badgeTone: "warning" };
  }
  if (counts.passed > 0) return { badge: `✓ ${counts.passed}`, badgeTone: "success" };
  return { badge: "— skipped", badgeTone: "neutral" };
}

// ---- Shaping the view model ----

/** Group order is the order you should look at them in: what is broken,
 *  what is blocked on you, what is still moving, what is done waiting. */
const GROUP_ORDER = [
  "CI failing",
  "Changes requested",
  "CI running",
  "Ready to merge",
  "Waiting on review",
  "Drafts",
];

function groupOf(pullRequest, counts) {
  if (counts.failed > 0) return "CI failing";
  if (pullRequest.isDraft) return "Drafts";
  if (pullRequest.reviewDecision === "CHANGES_REQUESTED") return "Changes requested";
  if (counts.running > 0) return "CI running";
  if (pullRequest.reviewDecision === "APPROVED") return "Ready to merge";
  return "Waiting on review";
}

function groupByAttention(pullRequests) {
  const groups = new Map();
  for (const pullRequest of pullRequests) {
    const checks = checksOf(pullRequest);
    const counts = tally(checks);
    const title = groupOf(pullRequest, counts);
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(itemOf(pullRequest, counts, checks.length));
  }
  return GROUP_ORDER.filter((title) => groups.has(title)).map((title) => ({
    title,
    items: groups.get(title),
  }));
}

function itemOf(pullRequest, counts, total) {
  const where = `${pullRequest.repository.nameWithOwner} #${pullRequest.number}`;
  const conflicting = pullRequest.mergeable === "CONFLICTING";
  // A PR with no checks leaves the badge slot free — spend it on the
  // conflict, which would otherwise only whisper from the subtitle. When
  // CI owns the badge, the subtitle carries the conflict instead; it is
  // never said twice.
  const badgeIsConflict = conflicting && total === 0;
  const preview = previewOf(pullRequest);
  const live = preview && !preview.expired;
  const notes = [
    conflicting && !badgeIsConflict ? "⚠ conflicts" : null,
    // Only a live one is worth the width; an expired preview is a row of
    // 404s and saying so on every stale PR would be noise.
    live ? "▶ preview" : null,
  ].filter(Boolean);
  return {
    id: itemId(pullRequest),
    title: pullRequest.title,
    subtitle: notes.length > 0 ? `${where} · ${notes.join(" · ")}` : where,
    menu: [
      ...(live ? [{ id: "open-preview", label: "Open preview…" }] : []),
      {
        id: "hide-repo",
        label: `Hide ${pullRequest.repository.nameWithOwner}`,
      },
    ],
    ...(badgeIsConflict
      ? { badge: "⚠ conflicts", badgeTone: "danger" }
      : ciBadge(counts, total)),
  };
}

function itemId(pullRequest) {
  return `${pullRequest.repository.nameWithOwner}#${pullRequest.number}`;
}

// ---- Preview environments ----
//
// Read from the CHECKS on the head commit, not from the PR's comments.
// A deploy bot announces the preview in both places, but the comment is
// posted once and then edited, so on a busy pull request it sinks under
// the discussion and any fixed "last N comments" window misses it. The
// check hangs off the head commit: it cannot be buried, it is always the
// current deploy rather than an old one, and it costs nothing extra —
// the checks are already fetched to badge the CI status.
//
// There is no standard for what the announcement says, so this reads the
// shape they share: a URL on a line that calls itself ready or a
// preview, plus a second confirming signal. The comment is still worth
// having for its login table, so it is fetched lazily, for one pull
// request, only when the reader actually opens the preview.

/** An ISO instant after the word "expires". */
const EXPIRES_AT = /\bexpires?\b[^\n]*?(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i;
/** A line that is announcing something, not merely linking to it. */
const ANNOUNCEMENT = /\b(ready|preview|deployed|deployment|staging)\b/i;
/** Trailing sentence punctuation is not part of the URL: a comment that
 *  reads "…deployed to https://pr-42.example.dev." ends in prose. */
const URL_IN_LINE = /https?:\/\/[^\s<>()[\]"'`]+/;

/** The preview announced by a check on the head commit, or null. */
function previewOf(pullRequest) {
  const commit = ((pullRequest.commits || {}).nodes || [])[0];
  const rollup = commit && commit.commit && commit.commit.statusCheckRollup;
  const nodes = (rollup && rollup.contexts && rollup.contexts.nodes) || [];
  for (const node of nodes) {
    // Any check may be the one announcing it — matching on a name like
    // "preview" would only work for the bots that happen to use it.
    const found = announcementIn([node.title, node.summary].filter(Boolean).join("\n\n"));
    if (found) return found;
  }
  return null;
}

/** The announcement inside any block of text, or null if it is not one. */
function announcementIn(text) {
  if (typeof text !== "string" || !text) return null;
  const url = announcedUrl(text);
  if (!url) return null;
  const expiry = text.match(EXPIRES_AT);
  const expiresAt = expiry ? expiry[1] : null;
  // The expiry is one signal; a host that says "preview" is the other.
  // Without either, this is ordinary text that happens to link out.
  if (!expiresAt && !/preview/i.test(hostOf(url))) return null;
  return { url, expiresAt, body: text, expired: isExpired(expiresAt) };
}

function announcedUrl(body) {
  for (const line of body.split(/\r?\n/)) {
    if (!ANNOUNCEMENT.test(line)) continue;
    const match = line.match(URL_IN_LINE);
    if (match) return match[0].replace(/[.,;:]+$/, "");
  }
  return null;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function isExpired(expiresAt) {
  // Nothing said is not the same as expired — some bots keep a preview
  // up for the life of the branch and never mention an end.
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at <= Date.now();
}

/** "in 3 hours", "in 12 minutes" — an absolute timestamp does not answer
 *  the only question being asked, which is whether it is still worth
 *  clicking. */
function expiryLabel(expiresAt) {
  if (!expiresAt) return "Not stated";
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return expiresAt;
  const minutes = Math.round((at - Date.now()) / 60_000);
  if (minutes <= 0) return `Expired (${new Date(at).toLocaleString()})`;
  if (minutes < 60) return `in ${minutes} min (${new Date(at).toLocaleTimeString()})`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h (${new Date(at).toLocaleString()})`;
  return `in ${Math.round(hours / 24)} days (${new Date(at).toLocaleString()})`;
}

const PR_COMMENTS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $comments: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { comments(last: $comments) { nodes { body } } }
  }
}`;

/**
 * The bot's own comment about this preview, if it can be found — it
 * carries the full login table the check's one-line summary abbreviates.
 * One request for one pull request, made only because the reader asked
 * to see the preview; the panel's own load stays a single query.
 */
async function announcementComment(pullRequest, preview) {
  const [owner, name] = pullRequest.repository.nameWithOwner.split("/");
  try {
    const body = {
      query: PR_COMMENTS_QUERY,
      variables: { owner, name, number: pullRequest.number, comments: MAX_COMMENTS },
    };
    const token = readToken();
    const data = token ? await graphqlOverHttp(token, body) : await graphqlOverGhCli(body);
    const nodes = data.repository.pullRequest.comments.nodes || [];
    // Newest first, and only a comment naming the SAME preview: an older
    // one describes an environment that is already gone.
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const text = nodes[i] && nodes[i].body;
      if (typeof text === "string" && text.includes(preview.url)) return text;
    }
  } catch (e) {
    // The check already told us everything essential; a failure here
    // costs the login table, not the preview.
    log(`comment lookup failed: ${e && e.message ? e.message : e}`);
  }
  return null;
}

/** The announcement, shown as it was written — the login table and the
 *  runbook link come along for free, and stay right whenever the bot
 *  changes them. */
async function previewDetail(pullRequest, preview) {
  const comment = await announcementComment(pullRequest, preview);
  return {
    title: "Preview environment",
    subtitle: itemId(pullRequest),
    fields: [
      { label: "URL", value: preview.url },
      { label: "Expires", value: expiryLabel(preview.expiresAt) },
      { label: "Pull request", value: pullRequest.title },
    ],
    body: comment || preview.body,
    url: preview.url,
  };
}

function detailOf(pullRequest) {
  const checks = checksOf(pullRequest);
  const counts = tally(checks);
  const fields = [
    { label: "Repository", value: pullRequest.repository.nameWithOwner },
    { label: "Branch", value: `${pullRequest.headRefName} → ${pullRequest.baseRefName}` },
    { label: "Checks", value: checksSummary(counts, checks.length) },
    { label: "Review", value: reviewLabel(pullRequest.reviewDecision) },
    { label: "Mergeable", value: mergeableLabel(pullRequest.mergeable) },
    { label: "Updated", value: new Date(pullRequest.updatedAt).toLocaleString() },
  ];
  if (pullRequest.isDraft) fields.unshift({ label: "State", value: "Draft" });
  const preview = previewOf(pullRequest);
  if (preview) {
    fields.push({
      label: "Preview",
      value: preview.expired ? `Expired — ${preview.url}` : preview.url,
    });
  }
  return {
    title: pullRequest.title,
    subtitle: itemId(pullRequest),
    fields,
    // The link is repeated as markdown because a field is plain text:
    // this is the one the reader can actually click.
    body: preview && !preview.expired
      ? `${checksBody(checks)}\n\n**Preview:** [${preview.url}](${preview.url}) — expires ${expiryLabel(preview.expiresAt)}`
      : checksBody(checks),
    url: pullRequest.url,
  };
}

function checksSummary(counts, total) {
  if (total === 0) return "No checks on the head commit";
  const parts = [];
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.running > 0) parts.push(`${counts.running} running`);
  if (counts.passed > 0) parts.push(`${counts.passed} passed`);
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  return parts.join(", ");
}

/** The body leads with what is wrong — failing first, then still
 *  running; passing checks are a count, not a wall of green. */
function checksBody(checks) {
  if (checks.length === 0) {
    return "*No CI checks reported on the head commit.*";
  }
  const sections = [];
  const failed = checks.filter((check) => check.state === "failed");
  const running = checks.filter((check) => check.state === "running");
  if (failed.length > 0) sections.push(`**Failing**\n\n${checkList(failed)}`);
  if (running.length > 0) sections.push(`**Running**\n\n${checkList(running)}`);
  const quiet = checks.filter(
    (check) => check.state === "passed" || check.state === "skipped",
  );
  if (quiet.length > 0) {
    sections.push(
      `**Passing** — ${quiet.length} other check${quiet.length === 1 ? "" : "s"} passed or was skipped.`,
    );
  }
  return sections.join("\n\n");
}

function checkList(checks) {
  return checks
    .map((check) => (check.url ? `- [${check.name}](${check.url})` : `- ${check.name}`))
    .join("\n");
}

function reviewLabel(decision) {
  if (decision === "APPROVED") return "Approved";
  if (decision === "CHANGES_REQUESTED") return "Changes requested";
  if (decision === "REVIEW_REQUIRED") return "Review required";
  return "No review required";
}

function mergeableLabel(mergeable) {
  if (mergeable === "MERGEABLE") return "Yes";
  if (mergeable === "CONFLICTING") return "No — conflicts with the base branch";
  return "GitHub is still calculating";
}
