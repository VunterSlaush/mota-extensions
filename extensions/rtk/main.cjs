// Token Saver (rtk) for Mota Editor — turns rtk on for your Claude
// sessions the first time the panel opens and shows how many tokens it
// has saved. Plain Node (18+), no dependencies: one JSON object per
// stdin line in, one per stdout line out (MXP, docs/EXTENSIONS.md in
// mota-editor).
//
// rtk (https://github.com/rtk-ai/rtk) is a Claude Code PreToolUse hook
// that rewrites shell commands so their output is compressed before the
// model reads it. Mota's Claude sessions load ~/.claude/settings.json,
// so once the hook is there it fires inside Mota with no host change.
//
// Setup is everything rtk needs, done once and unattended: rtk itself
// (package manager), the Claude hook (rtk init), a commented config.toml
// when none exists (the one file this extension writes, never over an
// existing one), and ripgrep, which some rtk filters shell out to.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const RELEASES_URL = "https://github.com/rtk-ai/rtk/releases";
const SCOPE_NOTE = "Claude sessions only. Codex has no hook; Gemini not yet verified.";
const ESTIMATE_NOTE =
  "Tokens are estimated as bytes ÷ 4 on the shell output rtk filtered — a reliable ratio, not your bill.";

const VERSION_TIMEOUT_MS = 5_000;
const GAIN_TIMEOUT_MS = 10_000;
const INIT_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 300_000;
const ERROR_TAIL_LINES = 20;
const DAYS_SHOWN = 7;

const IS_WINDOWS = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const RTK_EXE = IS_WINDOWS ? "rtk.exe" : "rtk";
const CONFIG_REFERENCE_URL = "https://www.rtk-ai.app/guide/getting-started/configuration";

/** Written only when rtk has no config yet. A section rtk does not find
 *  takes its defaults, but a section it does find must be complete —
 *  `[tee]` in particular names every field — so this stays a copy of
 *  rtk's own defaults (v0.48) with the knobs a Mota user is likely to
 *  reach for explained where they will look for them. */
const DEFAULT_CONFIG_TOML = `# rtk configuration — created by Mota's Token Saver extension because none existed.
# rtk reads this file on every command. Edit freely; nothing overwrites it.
# Reference: ${CONFIG_REFERENCE_URL}

[hooks]
# Commands the Claude hook must never rewrite, e.g. ["git push", "curl", "playwright"].
# Plain entries match by prefix; an entry starting with "^" is a regex.
exclude_commands = []
# Wrappers to look through before matching, e.g. ["docker exec app", "direnv exec ."].
transparent_prefixes = []

[tee]
# Keep the full raw output on disk when a filtered command fails, so Claude can read it.
# mode: "failures", "always", or "never". Every field below is required by rtk.
enabled = true
mode = "failures"
max_files = 20
max_file_size = 1048576

[awareness]
# "default": Claude only learns how to read condensed output. "high": it also learns
# what rtk is and how to bypass it. "full": it is told to prefix commands with rtk itself.
level = "default"

[telemetry]
enabled = false
`;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyError = (id, message) =>
  send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
const log = (message) => send({ jsonrpc: "2.0", method: "host/log", params: { message } });

let panelId = "savings";
/** Ids for the requests this process sends; the host's own ids are its
 *  business, so a high floor keeps a reader from confusing the two. */
let outgoingId = 1_000_000;

/** The install/configure job in flight, or null. One at a time: a second
 *  press while winget is running is answered with the interim view. */
let job = null;
/** Last ERROR_TAIL_LINES lines of the last failed job, for the status row. */
let lastError = "";
/** Setup runs by itself the first time the panel loads and finds work to
 *  do — once per process, so a failure is shown, not retried in a loop.
 *  The Enable button stays for running it again by hand. */
let autoSetupTried = false;
/** projectPath → savings, so opening a detail re-renders instead of
 *  spawning rtk twice more. Cleared whenever rtk's state changes. */
const savingsCache = new Map();
/** What the last render was built from, so a click on a row can answer
 *  a detail without re-detecting. */
let lastModel = null;

// Exiting the moment `shutdown` arrives would drop replies still being
// built (the host batches stdin) — drain in-flight requests first, with
// a hard stop so a hung spawn cannot outlive the host's kill window.
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
  // An answer to something this process asked (panels/refresh) has no
  // method; there is nothing to do with it.
  if (typeof msg.method !== "string") return;
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
    reply(msg.id, { protocolVersion: 1 });
  } else if (msg.method === "panel/load") {
    if (msg.params && msg.params.panelId) panelId = msg.params.panelId;
    reply(msg.id, { view: await buildView(contextOf(msg.params), { useCache: false }) });
  } else if (msg.method === "panel/action") {
    reply(msg.id, await handleAction(msg.params || {}));
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

function contextOf(params) {
  const context = (params && params.context) || {};
  return { projectPath: typeof context.projectPath === "string" ? context.projectPath : "" };
}

// ---- The panel ----

async function buildView(context, { useCache }) {
  const detection = await detect();
  if (!job && !autoSetupTried && setupWouldHelp(detection)) {
    autoSetupTried = true;
    return startJob("enable", context, detection);
  }
  const savings = detection.rtkPath
    ? await loadSavings(detection.rtkPath, context.projectPath, useCache)
    : null;
  lastModel = { detection, savings, context };
  return renderView(lastModel);
}

async function handleAction(params) {
  const { action, itemId: id, value } = params;
  const context = contextOf(params);
  if (action === "button") {
    if (id === "enable" || id === "disable") return { view: await startJob(id, context) };
    return {};
  }
  // A menu entry names the detail it opens, so both actions end in the
  // same place: the row a user clicked, or the one they asked for.
  if (action === "open" || action === "menu") {
    if (!lastModel) await buildView(context, { useCache: true });
    const detail = detailOf(action === "menu" ? value : id, lastModel);
    return detail ? { detail } : {};
  }
  return {};
}

// ---- Detection ----

/**
 * Where rtk is, whether Claude's hook points at it, and what could
 * install it. Cheap enough to run on every load: one `rtk --version`
 * plus a few stat calls.
 */
async function detect() {
  // Probed by name, the way the `claude` process will find it: a PATH
  // scan by stat() misses Windows app-execution aliases that spawn()
  // resolves fine. The absolute path is looked up afterwards for the
  // detail modal and for naming the binary in later spawns.
  let rtkPath = null;
  let version = "";
  let staleEnvironment = false;
  const onPath = await run("rtk", ["--version"], { timeoutMs: VERSION_TIMEOUT_MS });
  if (onPath.code === 0) {
    rtkPath = findOnPath(RTK_EXE) || "rtk";
    version = onPath.stdout.trim();
  }
  if (!rtkPath) {
    // A binary in one of the usual install folders that is NOT on our
    // PATH means it was installed after Mota started: this process, and
    // the `claude` Mota spawns, still carry the old PATH.
    for (const dir of fallbackDirs()) {
      const candidate = path.join(dir, RTK_EXE);
      if (!fs.existsSync(candidate)) continue;
      const probe = await run(candidate, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS });
      if (probe.code === 0) {
        rtkPath = candidate;
        version = probe.stdout.trim();
        staleEnvironment = true;
        break;
      }
    }
  }
  const hook = readHook();
  const ripgrep = (await run("rg", ["--version"], { timeoutMs: VERSION_TIMEOUT_MS })).code === 0;
  // Only worth a spawn when there is something to install.
  const packageManager = rtkPath && ripgrep ? null : await findPackageManager();
  const configPath = rtkConfigPath();
  return {
    state: stateOf({ rtkPath, staleEnvironment, hook }, packageManager),
    rtkPath,
    version,
    staleEnvironment,
    hook,
    packageManager,
    ripgrep,
    configPath,
    configPresent: fs.existsSync(configPath),
  };
}

/** Whether setup has anything left to do here: what an Enable press would
 *  fix, or — for an rtk that is already on — a missing config or ripgrep.
 *  This is the test that runs setup unasked when the panel opens. */
function setupWouldHelp(detection) {
  if (buttonsFor(detection).some((button) => button.id === "enable")) return true;
  if (!detection.rtkPath) return false;
  const pm = detection.packageManager;
  return !detection.configPresent || (!detection.ripgrep && Boolean(pm && pm.ripgrepArgs));
}

function stateOf({ rtkPath, staleEnvironment, hook }, packageManager) {
  if (hook.present && !rtkPath) return "hookBroken";
  if (rtkPath && staleEnvironment) return "needsRestart";
  if (rtkPath && hook.present) return "active";
  if (rtkPath) return "installedNoHook";
  return packageManager ? "notInstalled" : "noPackageManager";
}

function fallbackDirs() {
  const home = os.homedir();
  if (IS_WINDOWS) {
    return [
      path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Microsoft", "WinGet", "Links"),
      path.join(home, "scoop", "shims"),
      path.join(home, ".cargo", "bin"),
    ];
  }
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
  ];
}

/** The first PATH entry holding `name`, as an absolute path — resolved
 *  here so every later spawn names the file and never a shell lookup. */
function findOnPath(name) {
  const entries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of entries) {
    const candidate = existing(path.join(dir, name));
    if (candidate) return candidate;
  }
  return null;
}

/** The claude settings file rtk patches, honouring the same override
 *  Claude Code and rtk both read. */
function claudeSettingsPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(dir, "settings.json");
}

/** Whether a PreToolUse hook on Bash runs `rtk hook claude` — the same
 *  test rtk applies to recognise its own entry: three words, the first
 *  being rtk by any path. Missing or malformed settings read as absent. */
function readHook() {
  const settingsPath = claudeSettingsPath();
  let root;
  try {
    root = JSON.parse(fs.readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return { present: false, command: "", settingsPath };
  }
  const entries = root && root.hooks && Array.isArray(root.hooks.PreToolUse) ? root.hooks.PreToolUse : [];
  for (const entry of entries) {
    if (!entry || !matchesBash(entry.matcher) || !Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      const command = hook && typeof hook.command === "string" ? hook.command : "";
      if (isRtkHookCommand(command)) return { present: true, command, settingsPath };
    }
  }
  return { present: false, command: "", settingsPath };
}

function matchesBash(matcher) {
  if (typeof matcher !== "string") return false;
  return matcher.split("|").map((part) => part.trim()).includes("Bash");
}

function isRtkHookCommand(command) {
  const words = shellWords(command);
  if (words.length !== 3) return false;
  const binary = path.basename(words[0]).replace(/\.exe$/i, "");
  return binary === "rtk" && words[1] === "hook" && words[2] === "claude";
}

/** Splits on whitespace, honouring single and double quotes — enough for
 *  `"C:\Program Files\rtk\rtk.exe" hook claude`. */
function shellWords(text) {
  const words = [];
  let current = "";
  let quote = null;
  let inWord = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
}

/**
 * What can install rtk here: winget, then scoop on Windows; brew on
 * macOS; nothing on Linux, where rtk's own install script is the route
 * and this extension will not pipe it to a shell for you.
 */
async function findPackageManager() {
  const home = os.homedir();
  if (IS_WINDOWS) {
    // winget lives behind an app-execution alias that stat() cannot
    // see, so it is probed the only way that is reliable: by running it.
    const winget = await run("winget", ["--version"], { timeoutMs: VERSION_TIMEOUT_MS });
    if (winget.code === 0) {
      const flags = ["-e", "--accept-source-agreements", "--accept-package-agreements", "--disable-interactivity"];
      return {
        name: "winget",
        command: "winget",
        args: ["install", "--id", "rtk-ai.rtk", ...flags],
        display: "winget install --id rtk-ai.rtk -e",
        ripgrepArgs: ["install", "--id", "BurntSushi.ripgrep.MSVC", ...flags],
        ripgrepDisplay: "winget install --id BurntSushi.ripgrep.MSVC -e",
      };
    }
    // scoop is a .cmd shim; Node will not run one without a shell, so
    // cmd.exe is named outright with a fixed argument list — nothing
    // user-supplied is ever part of it.
    const scoop = existing(path.join(home, "scoop", "shims", "scoop.cmd"));
    if (scoop) {
      return {
        name: "scoop",
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/c", scoop, "install", "rtk"],
        display: "scoop install rtk",
        ripgrepArgs: ["/d", "/c", scoop, "install", "ripgrep"],
        ripgrepDisplay: "scoop install ripgrep",
      };
    }
    return null;
  }
  if (IS_MAC) {
    const brew = findOnPath("brew") || existing("/opt/homebrew/bin/brew") || existing("/usr/local/bin/brew");
    if (brew) {
      return {
        name: "brew",
        command: brew,
        args: ["install", "rtk"],
        display: "brew install rtk",
        ripgrepArgs: ["install", "ripgrep"],
        ripgrepDisplay: "brew install ripgrep",
      };
    }
  }
  return null;
}

/** The path if something other than a folder is there. lstat, not stat:
 *  winget sits behind a Windows app-execution alias, a reparse point
 *  that stat() refuses to follow but that spawn() runs fine. */
function existing(filePath) {
  try {
    return fs.lstatSync(filePath).isDirectory() ? null : filePath;
  } catch {
    return null;
  }
}

// ---- Savings ----

async function loadSavings(rtkPath, projectPath, useCache) {
  const key = projectPath || "";
  if (useCache && savingsCache.has(key)) return savingsCache.get(key);
  const all = await gain(rtkPath, ["--all"], os.homedir());
  const project = projectPath && fs.existsSync(projectPath) ? await gain(rtkPath, ["--project"], projectPath) : null;
  const savings = { all, project };
  savingsCache.set(key, savings);
  return savings;
}

/** One `rtk gain --format json` run, read tolerantly: a field rtk stops
 *  printing becomes a zero rather than a crash. Null when rtk fails. */
async function gain(rtkPath, extraArgs, cwd) {
  const result = await run(rtkPath, ["gain", "--format", "json", ...extraArgs], {
    cwd,
    timeoutMs: GAIN_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    log(`rtk gain ${extraArgs.join(" ")} failed: ${result.error || tail(result.stderr)}`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    log(`rtk gain printed something that is not JSON: ${e.message}`);
    return null;
  }
  const summary = (parsed && parsed.summary) || {};
  const daily = Array.isArray(parsed && parsed.daily) ? parsed.daily : [];
  return {
    commands: count(summary.total_commands),
    input: count(summary.total_input),
    output: count(summary.total_output),
    saved: count(summary.total_saved),
    percent: Number.isFinite(summary.avg_savings_pct) ? summary.avg_savings_pct : 0,
    daily: daily
      .filter((day) => day && typeof day.date === "string")
      .map((day) => ({
        date: day.date,
        commands: count(day.commands),
        saved: count(day.saved_tokens),
        percent: Number.isFinite(day.savings_pct) ? day.savings_pct : 0,
      })),
  };
}

function count(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

// ---- Shaping the view model ----

/** What the status row says while a job runs, by phase. */
const JOB_PHASES = {
  install: { title: "Installing rtk…", subtitle: "", badge: "Installing…" },
  configure: { title: "Turning the hook on…", subtitle: "Editing ~/.claude/settings.json.", badge: "Configuring…" },
  extras: { title: "Finishing setup…", subtitle: "Writing rtk's config and installing ripgrep.", badge: "Configuring…" },
  remove: { title: "Turning the hook off…", subtitle: "Editing ~/.claude/settings.json.", badge: "Configuring…" },
};

const STATUS = {
  active: { title: "rtk is on", badge: "Active", tone: "success" },
  notInstalled: { title: "rtk is not installed", badge: "Not installed", tone: "neutral" },
  noPackageManager: { title: "rtk is not installed", badge: "Not installed", tone: "neutral" },
  installedNoHook: { title: "rtk is installed but not hooked up", badge: "Hook missing", tone: "warning" },
  needsRestart: { title: "Restart Mota to finish", badge: "Restart Mota", tone: "warning" },
  hookBroken: { title: "The Claude hook points at a missing rtk", badge: "Hook broken", tone: "danger" },
};

function renderView(model) {
  const { detection, savings } = model;
  const groups = [{ title: "Status", items: [statusItem(detection)] }];
  if (savings) groups.push(...savingsGroups(savings));
  return {
    groups,
    buttons: job ? [] : buttonsFor(detection),
    emptyText: emptyTextFor(detection),
  };
}

/** The whole of Status is this one row: the panel is here for the
 *  savings, and a working setup has nothing to say. rtk's config and
 *  ripgrep used to be rows of their own — they are the right-click menu
 *  now, and every path and knob is still in the row's own detail. */
const STATUS_MENU = [
  { id: "config", label: "rtk config…" },
  { id: "ripgrep", label: "ripgrep…" },
];

function statusItem(detection) {
  const state = detection.state;
  const status = STATUS[state];
  if (job) {
    const phase = JOB_PHASES[job.kind];
    return {
      id: "status",
      title: phase.title,
      subtitle: job.kind === "install" ? `${detection.packageManager.display} — this can take a minute.` : phase.subtitle,
      badge: phase.badge,
      badgeTone: "info",
    };
  }
  return {
    id: "status",
    title: status.title,
    subtitle:
      lastError && state !== "active" ? `Last attempt failed: ${firstLine(lastError)}` : subtitleFor(detection),
    badge: status.badge,
    badgeTone: status.tone,
    menu: STATUS_MENU,
  };
}

/** One short clause, and only when the user has something to do about
 *  it — a second line is the cost of saying anything here. Setup already
 *  ran by itself (or could not), so the words point at the retry, not at
 *  a first step; the reasons live in the detail behind the row. */
function subtitleFor(detection) {
  switch (detection.state) {
    case "active":
      return detection.ripgrep ? "" : "ripgrep is not on PATH — rtk works without it.";
    case "installedNoHook":
      return "Press Enable to add the Claude hook.";
    case "needsRestart":
      return detection.hook.present
        ? "Restart Mota so Claude can find rtk."
        : "Press Enable to add the hook, then restart Mota.";
    case "hookBroken":
      return "Commands still run, uncompressed. Press Enable to reinstall rtk.";
    case "notInstalled":
      return `Press Enable to install it with ${detection.packageManager.name}.`;
    case "noPackageManager":
      return "No winget, scoop or brew here. Click for the manual install line.";
    default:
      return "";
  }
}

function emptyTextFor(detection) {
  switch (detection.state) {
    case "notInstalled":
      return `rtk is not installed. Press Enable to install it with ${detection.packageManager.name} and turn it on for Claude.`;
    case "noPackageManager":
      return "rtk is not installed and no package manager was found. Open the status row for the install line.";
    case "installedNoHook":
      return "rtk is installed. Press Enable to turn it on for Claude.";
    default:
      return "No commands compressed yet — send a Claude message that runs a shell command, then refresh.";
  }
}

/** Enable wherever a press can make progress; Disable wherever there is
 *  a hook to remove and an rtk to remove it with. */
function buttonsFor(detection) {
  const { state, rtkPath, packageManager } = detection;
  const buttons = [];
  const canInstall = Boolean(packageManager);
  const canInit = Boolean(rtkPath);
  const enable =
    (state === "notInstalled" && canInstall) ||
    (state === "installedNoHook" && canInit) ||
    (state === "hookBroken" && canInstall) ||
    (state === "needsRestart" && !detection.hook.present && canInit);
  if (enable) buttons.push({ id: "enable", label: "Enable" });
  if ((state === "active" || (state === "needsRestart" && detection.hook.present)) && canInit) {
    buttons.push({ id: "disable", label: "Disable" });
  }
  return buttons;
}

function savingsGroups(savings) {
  const groups = [];
  const all = savings.all;
  if (all) {
    groups.push({
      title: "Savings (all projects)",
      items:
        all.commands === 0
          ? [
              {
                id: "all:none",
                title: "No commands compressed yet",
                subtitle: "Send a Claude message that runs a shell command, then refresh.",
              },
            ]
          : savingsItems("all", all),
    });
  }
  const project = savings.project;
  if (project && project.commands > 0) {
    groups.push({ title: "This project", items: savingsItems("project", project) });
  }
  if (all && all.daily.length > 0) {
    const days = [...all.daily].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, DAYS_SHOWN);
    groups.push({
      title: "Last 7 days",
      items: days.map((day) => ({
        id: `day:${day.date}`,
        title: day.date,
        subtitle: `${day.commands} command${day.commands === 1 ? "" : "s"}`,
        badge: formatTokens(day.saved),
        badgeTone: day.saved > 0 ? "success" : "neutral",
      })),
    });
  }
  return groups;
}

function savingsItems(prefix, stats) {
  return [
    {
      id: `${prefix}:saved`,
      title: "Tokens saved",
      subtitle: `${formatTokens(stats.input)} in → ${formatTokens(stats.output)} out`,
      badge: formatTokens(stats.saved),
      badgeTone: stats.saved > 0 ? "success" : "neutral",
    },
    {
      id: `${prefix}:commands`,
      title: "Commands compressed",
      badge: formatTokens(stats.commands),
      badgeTone: "info",
    },
    {
      id: `${prefix}:percent`,
      title: "Average reduction",
      subtitle: "Of the shell output bytes Claude would have read",
      badge: `${Math.round(stats.percent)}%`,
      badgeTone: stats.percent >= 50 ? "success" : "warning",
    },
  ];
}

/** 1234 → 1.2K, 1234567 → 1.2M: a badge is glance-sized. */
function formatTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trim1(n / 1000)}K`;
  return `${trim1(n / 1_000_000)}M`;
}

function trim1(value) {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

// ---- Details ----

function detailOf(id, model) {
  if (id === "status") return statusDetail(model.detection);
  if (id === "config") return configDetail(model.detection);
  if (id === "ripgrep") return ripgrepDetail(model.detection);
  const savings = model.savings || {};
  if (id.startsWith("all:") && savings.all) return savingsDetail("All projects", savings.all);
  if (id.startsWith("project:") && savings.project) {
    return savingsDetail(model.context.projectPath || "This project", savings.project);
  }
  if (id.startsWith("day:") && savings.all) {
    const day = savings.all.daily.find((entry) => `day:${entry.date}` === id);
    if (day) {
      return {
        title: day.date,
        fields: [
          { label: "Commands", value: String(day.commands) },
          { label: "Tokens saved", value: day.saved.toLocaleString() },
          { label: "Reduction", value: `${Math.round(day.percent)}%` },
        ],
        body: ESTIMATE_NOTE,
      };
    }
  }
  return null;
}

function savingsDetail(title, stats) {
  return {
    title: `Token savings — ${title}`,
    fields: [
      { label: "Commands compressed", value: stats.commands.toLocaleString() },
      { label: "Input tokens (raw output)", value: stats.input.toLocaleString() },
      { label: "Output tokens (after rtk)", value: stats.output.toLocaleString() },
      { label: "Saved", value: `${stats.saved.toLocaleString()} (${Math.round(stats.percent)}%)` },
    ],
    body: ESTIMATE_NOTE,
  };
}

function statusDetail(detection) {
  const fields = [
    { label: "rtk", value: detection.rtkPath ? `${detection.rtkPath}${detection.version ? ` (${detection.version})` : ""}` : "Not found" },
    { label: "Claude hook", value: detection.hook.present ? detection.hook.command : "Not set" },
    { label: "Claude settings", value: detection.hook.settingsPath },
    { label: "rtk config", value: rtkConfigPath() },
    { label: "ripgrep on PATH", value: detection.ripgrep ? "Yes" : "No — some rtk filters shell out to rg" },
    { label: "Package manager", value: detection.packageManager ? detection.packageManager.name : "None found" },
  ];
  const sections = [
    `**Scope.** ${SCOPE_NOTE} The hook fires inside the \`claude\` process Mota starts, so a fresh install needs one Mota restart before its PATH sees rtk.`,
    `**By hand**\n\n\`\`\`\n${manualCommands(detection).join("\n")}\n\`\`\``,
    "**Escape hatches.** Prefix one command with `RTK_DISABLED=1` to run it unfiltered. List commands rtk must leave alone under `[hooks] exclude_commands` in its config.toml.",
  ];
  if (lastError) sections.push(`**Last error**\n\n\`\`\`\n${lastError}\n\`\`\``);
  return {
    title: STATUS[detection.state].title,
    subtitle: STATUS[detection.state].badge,
    fields,
    body: sections.join("\n\n"),
    url: RELEASES_URL,
  };
}

function configDetail(detection) {
  let contents = "";
  if (detection.configPresent) {
    try {
      contents = fs.readFileSync(detection.configPath, "utf8");
    } catch (e) {
      contents = `(could not read it: ${e.message})`;
    }
  }
  const body = [
    "rtk reads this file on every command, so an edit applies to the next one. Nothing overwrites it; setup only writes it when it is missing.",
    detection.configPresent
      ? `**Current contents**\n\n\`\`\`toml\n${contents.trim()}\n\`\`\``
      : `**What setup writes**\n\n\`\`\`toml\n${DEFAULT_CONFIG_TOML.trim()}\n\`\`\``,
    "**Most useful knob.** `[hooks] exclude_commands` — commands the Claude hook must leave alone, e.g. `[\"git push\", \"curl\"]`. For a single command, prefix it with `RTK_DISABLED=1` instead.",
  ];
  return {
    title: "rtk config",
    subtitle: detection.configPresent ? "Present" : "Missing",
    fields: [{ label: "Path", value: detection.configPath }],
    body: body.join("\n\n"),
    url: CONFIG_REFERENCE_URL,
  };
}

function ripgrepDetail(detection) {
  const pm = detection.packageManager;
  const install = pm && pm.ripgrepDisplay ? pm.ripgrepDisplay : IS_WINDOWS ? "winget install --id BurntSushi.ripgrep.MSVC -e" : IS_MAC ? "brew install ripgrep" : "your distribution's ripgrep package";
  return {
    title: "ripgrep",
    subtitle: detection.ripgrep ? "Found" : "Missing",
    fields: [{ label: "On Mota's PATH", value: detection.ripgrep ? "Yes" : "No" }],
    body: [
      "Some rtk filters (grep, find, read) shell out to ripgrep (`rg`). Without it rtk still works and prints a one-line warning on those commands.",
      detection.ripgrep
        ? "Nothing to do."
        : `Setup installs it when a package manager is available. By hand:\n\n\`\`\`\n${install}\n\`\`\`\n\nLike rtk itself, a fresh install is only seen by Mota after a restart.`,
    ].join("\n\n"),
    url: "https://github.com/BurntSushi/ripgrep",
  };
}

function manualCommands(detection) {
  const install = IS_WINDOWS
    ? ["winget install --id rtk-ai.rtk -e", "scoop install rtk"]
    : IS_MAC
      ? ["brew install rtk"]
      : ["curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh"];
  const rtk = detection.rtkPath || "rtk";
  return [
    `# install${install.length > 1 ? " (pick one)" : ""}\n${install.join("\n")}`,
    `# turn on for Claude\n${quoteIfNeeded(rtk)} init -g --auto-patch --hook-only`,
    `# turn off\n${quoteIfNeeded(rtk)} init -g --uninstall`,
  ];
}

function quoteIfNeeded(filePath) {
  return /\s/.test(filePath) ? `"${filePath}"` : filePath;
}

/** rtk uses the platform config dir: %APPDATA% on Windows,
 *  ~/Library/Application Support on macOS, ~/.config elsewhere. */
function rtkConfigPath() {
  const home = os.homedir();
  const base = IS_WINDOWS
    ? process.env.APPDATA || path.join(home, "AppData", "Roaming")
    : IS_MAC
      ? path.join(home, "Library", "Application Support")
      : process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, "rtk", "config.toml");
}

// ---- Enable / Disable ----

/**
 * Answers at once with an interim view and does the work afterwards;
 * `panels/refresh` tells the host when to ask again. A press while a
 * job runs just re-renders the interim view.
 */
async function startJob(kind, context, known) {
  if (job) return renderView(lastModel || { detection: known || (await detect()), savings: null, context });
  // Claimed before the first await: two presses in the same host batch
  // would otherwise both pass the check above and race two installs.
  job = { kind: kind === "enable" ? "install" : "remove" };
  lastError = "";
  const detection = known || (await detect());
  if (kind === "enable" && detection.rtkPath) job.kind = detection.hook.present ? "extras" : "configure";
  const model = { detection, savings: null, context };
  lastModel = model;
  runJob(kind, detection)
    .catch((e) => {
      lastError = String(e && e.message ? e.message : e);
    })
    .finally(() => {
      job = null;
      savingsCache.clear();
      refreshPanel();
    });
  return renderView(model);
}

async function runJob(kind, detection) {
  if (kind === "disable") {
    if (!detection.rtkPath) throw new Error("rtk is not installed, so its hook cannot be removed by rtk.");
    await must(detection.rtkPath, ["init", "-g", "--uninstall"], INIT_TIMEOUT_MS);
    log("removed the Claude hook");
    return;
  }
  let rtkPath = detection.rtkPath;
  if (!rtkPath) {
    const pm = detection.packageManager;
    if (!pm) throw new Error("No package manager found to install rtk with.");
    log(`installing rtk: ${pm.display}`);
    await must(pm.command, pm.args, INSTALL_TIMEOUT_MS);
    const after = await detect();
    rtkPath = after.rtkPath;
    if (!rtkPath) {
      throw new Error(`${pm.name} finished but rtk was not found. Restart Mota and try again.`);
    }
  }
  if (!detection.hook.present) {
    job.kind = "configure";
    log(`turning the hook on with ${rtkPath}`);
    await must(rtkPath, ["init", "-g", "--auto-patch", "--hook-only"], INIT_TIMEOUT_MS);
  }
  // The extras never fail setup: rtk is on by this point, and the status
  // rows say what is still missing.
  job.kind = "extras";
  ensureConfig(detection.configPath);
  await ensureRipgrep(detection);
}

/** rtk's config, only if there is none — with comments, so the knobs a
 *  user might want are named where they will look for them. `wx` makes
 *  the "only if none" atomic: an existing file is never touched. */
function ensureConfig(configPath) {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, DEFAULT_CONFIG_TOML, { flag: "wx" });
    log(`wrote ${configPath}`);
  } catch (e) {
    if (e.code !== "EEXIST") log(`could not write ${configPath}: ${e.message}`);
  }
}

async function ensureRipgrep(detection) {
  if (detection.ripgrep) return;
  const pm = detection.packageManager;
  if (!pm || !pm.ripgrepArgs) return;
  log(`installing ripgrep: ${pm.ripgrepDisplay}`);
  const result = await run(pm.command, pm.ripgrepArgs, { timeoutMs: INSTALL_TIMEOUT_MS });
  if (result.code !== 0) log(`ripgrep install failed (rtk still works): ${result.error || firstLine(result.stderr)}`);
}

/** Runs and throws with the output tail on anything but exit 0. */
async function must(command, args, timeoutMs) {
  const result = await run(command, args, { timeoutMs });
  if (result.code === 0) return result;
  const output = tail(`${result.stderr}\n${result.stdout}`);
  throw new Error(result.error ? `${result.error}\n${output}`.trim() : output || `${path.basename(command)} exited with code ${result.code}`);
}

function refreshPanel() {
  outgoingId += 1;
  send({ jsonrpc: "2.0", id: outgoingId, method: "panels/refresh", params: { panelId } });
}

// ---- Spawning ----

/**
 * One child process, no shell, stdin closed, a timeout that cannot keep
 * the process alive. Never rejects: a missing binary or a timeout is a
 * result with `error` set, so callers decide what it means.
 */
function run(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    const result = { code: null, stdout: "", stderr: "", error: "" };
    const finish = () => resolve(result);
    try {
      child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      result.error = e.message;
      finish();
      return;
    }
    const timer = setTimeout(() => {
      result.error = `${path.basename(command)} took longer than ${Math.round(timeoutMs / 1000)} s.`;
      child.kill();
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk) => {
      result.stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      result.stderr += chunk;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      result.error = e.code === "ENOENT" ? `${command} was not found.` : e.message;
      finish();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      result.code = code;
      if (result.stderr.trim()) log(`${path.basename(command)} ${args[0] || ""}: ${firstLine(result.stderr)}`);
      finish();
    });
  });
}

function tail(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-ERROR_TAIL_LINES)
    .join("\n");
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/).find((line) => line.trim()) || "";
}
