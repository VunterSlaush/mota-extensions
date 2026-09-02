# Contributing an extension

Everything here is code other people will run on their own machines with
their own account. That is the whole reason this repository exists as a
reviewed index instead of a list of links — so the bar below is about
being *readable and honest*, not about polish.

## Before you open a pull request

```bash
node scripts/validate.mjs      # must pass — CI runs exactly this
node scripts/build-readme.mjs  # commit the regenerated catalog table
```

Both are plain Node, no dependencies, no install step.

## Hosted here, or your own repository?

**Hosted here** (`"source": {"kind": "path", …}`) — put the folder in
`extensions/<id>/` and the entry in `registry.json`. Best for most
extensions: users get it with one clone, and the review is a diff of the
actual code.

**Your own repository** (`"source": {"kind": "git", …}`) — the entry
points at an https clone URL whose *root* is the extension folder
(`mota-extension.json` at the top). Best when you want your own issues,
releases, and cadence. Note the trade-off for users: what was reviewed
here is the URL, and what they install is whatever that URL serves today.

## The entry

Add it to `registry.json`, **sorted by id**:

```json
{
  "id": "standup",
  "displayName": "Standup",
  "description": "Drafts a standup update and pings you when it is ready.",
  "version": "0.1.0",
  "author": { "name": "Your Name", "github": "your-handle" },
  "license": "MIT",
  "keywords": ["notes", "git"],
  "permissions": ["commands:register", "notifications"],
  "commands": ["standup", "standup-notify"],
  "panels": [],
  "runtime": "node",
  "setup": "Only when something is needed — an API key, a sign-in.",
  "source": { "kind": "path", "path": "extensions/standup" }
}
```

`displayName`, `description`, `version`, `permissions`, `commands` and
`panels` must match the manifest exactly — the validator checks, because
this is what people read *before* deciding to trust you. Full field list:
[`schema/registry.schema.json`](schema/registry.schema.json).

## The bar for a hosted extension

- **A README.md in the folder.** What it does, what it needs on PATH, what
  setup it requires, and one line per permission explaining *why*.
- **Declare the minimum permissions.** An extension asking for
  `shell:exec` or `agent:prompt` (which spends the user's AI credits) needs
  the reason in the README, and the review will be slower. A permission
  that is not used will be asked about.
- **No dependencies vendored, no build step.** Source that runs as
  committed. `node_modules/` and files over 1 MB are rejected by the
  validator — if your extension genuinely needs a package ecosystem, host
  it in your own repository and list it by URL.
- **Prefer a prompt command over a script.** A `kind: "prompt"` command is
  pure data: no process, no risk, and the consent dialog stays friendly.
  Reach for a script only when the behaviour has to be dynamic.
- **No secrets, ever.** Not in the manifest, not in the source, not in a
  committed config. Read them from the environment or from the `dataDir`
  the host hands you at `initialize`.
- **Network calls belong in the README.** Say which hosts you talk to and
  what you send. "It talks to an API" is not enough.
- **It has to actually run.** Install it from your branch, approve it in
  Mota, and use it once before opening the pull request.

## What review looks like

A maintainer reads the whole diff. Expect questions about any permission
that is not obviously needed, any network call that is not documented, and
anything that reads files outside the extension's own `dataDir`. Nothing
here is signed, audited, or sandboxed, and the README says so plainly —
which only works if the review is real.

Rejections are not personal, and "host it yourself and we'll link it" is
always available.

## Updating an extension

Bump `version` in both the manifest and the index (the validator checks
they agree) and describe the change in the pull request. If the change
adds a permission, say so in the title — Mota sends the extension back to
*needs approval* on the user's machine and asks again, and reviewers
should see it coming too.

## Removing one

Open a pull request that deletes the entry and, for a hosted extension,
the folder. Maintainers may also remove an extension that breaks, goes
unmaintained, or turns out to do something its manifest did not say.
