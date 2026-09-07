# Token Saver (rtk)

[rtk](https://github.com/rtk-ai/rtk) is a small Rust CLI that rewrites the
shell commands an AI agent runs so their output is compressed before the
model reads it — `git status`, test runners, linters, `find`, `grep` —
typically cutting that output by 60–90 %. It works through a Claude Code
`PreToolUse` hook in `~/.claude/settings.json`, and Mota's Claude sessions
load that file, so once the hook is there it fires inside Mota.

This extension gives you that hook in one press and shows what it saved:

- **Status** — whether rtk is installed, whether the Claude hook is set,
  and what to do next. Click the row for paths, the manual commands, and
  a link to rtk's releases.
- **Savings (all projects)** — tokens saved, commands compressed, and the
  average reduction, from rtk's own history.
- **This project** — the same three numbers for the folder open in Mota.
- **Last 7 days** — one row per day.

**Claude sessions only.** Codex has no hook, and Gemini's hook has not
been verified under Mota. The panel says so.

## Setup

Nothing. Open the **Token Saver** panel and press **Enable**:

1. If rtk is missing it is installed with `winget` (or `scoop`) on
   Windows, `brew` on macOS. That can take a minute; the row says
   *Installing…* meanwhile.
2. `rtk init -g --auto-patch --hook-only` adds the hook to
   `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`).

**Restart Mota once after a fresh install.** The install adds rtk to your
PATH, but Mota — and the `claude` process it starts — were launched with
the old one. The panel detects this and shows *Restart Mota* until you do.

On Linux there is no package manager route: the status row shows rtk's
`curl … | sh` install line for you to run yourself. This extension never
pipes a remote script into a shell. Once rtk is on PATH, **Enable** sets
the hook.

**Disable** runs `rtk init -g --uninstall`, which removes the hook entry
(and, if you installed them yourself, rtk's `RTK.md` and `CLAUDE.md`
reference). rtk stays installed.

## Permissions

| Permission | Why |
|---|---|
| `ui:panel` | to contribute the sidebar panel |

That is the whole list. Running rtk and the package manager happens in
the extension's own process, which needs no permission from Mota — the
permission model covers what an extension asks the *host* to do.

## What it touches

- **Processes:** `rtk --version`, `rtk gain --format json --all` and
  `rtk gain --format json --project`, `rtk init -g --auto-patch --hook-only`
  on Enable, `rtk init -g --uninstall` on Disable, and one of
  `winget install --id rtk-ai.rtk -e`, `scoop install rtk`, or
  `brew install rtk` when rtk is missing. Every spawn names the binary
  by path with a fixed argument list; nothing goes through a shell.
- **Files read:** `~/.claude/settings.json` (to see whether the hook is
  set), PATH and the usual install folders (to find rtk).
- **Files written:** none by this extension. rtk writes
  `~/.claude/settings.json` (backing it up to `settings.json.bak` first)
  and keeps its history in `%LOCALAPPDATA%\rtk\history.db` /
  `~/.local/share/rtk/history.db`; its config is
  `%APPDATA%\rtk\config.toml` / `~/.config/rtk/config.toml`.
- **Network:** none from this extension. The package manager downloads
  the release archive from GitHub. rtk's anonymous telemetry is opt-in
  and asked about only on an interactive terminal; nothing here is
  interactive, so it stays off, and this extension never turns it on.

## Requirements

- Node 18+ (Mota's extension runtime). No dependencies.
- `winget` or `scoop` on Windows, `brew` on macOS — only to install rtk.
  rtk ships Windows x64, macOS and Linux builds; there is no Windows
  ARM64 build.
- Optionally [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) on
  PATH — some rtk filters shell out to it. The status detail says whether
  it was found.

## Reading the numbers

rtk estimates tokens as `bytes ÷ 4` on the shell output it filtered. The
percentage is reliable; the absolute counts are approximate and do not
match a provider's bill — shell output is one part of input tokens, and
input tokens are one part of the bill.

## Escape hatches

- Prefix a single command with `RTK_DISABLED=1` to run it unfiltered.
- Add commands rtk must leave alone to `[hooks] exclude_commands` in
  rtk's `config.toml`.
- **Disable** in the panel removes the hook entirely.

If the hook is set but rtk cannot be found (uninstalled, or moved), the
panel shows *Hook broken*. Claude Code treats a failing hook as
non-blocking, so shell commands still run — just uncompressed — until you
press Enable to reinstall or Disable to remove the entry.
