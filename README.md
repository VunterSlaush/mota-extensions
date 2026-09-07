# Mota Extensions

The extension store for [Mota Editor](https://github.com/VunterSlaush/mota-editor)
— a curated index plus the source of every extension hosted here.

An extension is **a folder**: a `mota-extension.json` manifest and,
optionally, one script speaking JSON-RPC over stdio. It can add slash
commands, hand MCP tools to your agents, and draw a panel in Mota's
sidebar.

> **Read what you install.** Extensions run as a normal program under your
> user account — Mota's permission model is *informed consent, not a
> sandbox*. Everything here is reviewed in a pull request and small enough
> to read in a few minutes, but it is not audited, signed, or isolated.
> Enabling one shows a native dialog listing exactly what it declared; if
> that list surprises you, say no.

## The catalog

<!-- catalog:start -->

| Extension | What it does | Adds | Permissions |
|---|---|---|---|
| [GitHub PRs](extensions/github-prs) | Your open pull requests in the sidebar, grouped by what needs you: CI failing, changes requested, running, ready to merge. Click one for the failing checks. *(setup required)* | a sidebar panel | `ui:panel` |
| [Token Saver (rtk)](extensions/rtk) | Compresses the shell output your Claude sessions read with rtk, and shows how many tokens it saved. *(setup required)* | a sidebar panel | `ui:panel` |
| [Standup](extensions/standup) | Drafts a standup update and pings you when it is ready. | `/standup`, `/standup-notify` | `commands:register` `notifications` |

<!-- catalog:end -->

Machine-readable: [`registry.json`](registry.json).

## Installing one

The short way: type **`/install-extension`** in any Mota chat to see this
catalog in the app, or `/install-extension github-prs` to install one.
The command is built into every install; it fetches the folder, shows you
the permissions the manifest declares, and asks before copying anything.

By hand is the same thing — Mota installs an extension by reading a
folder, so installing is copying a folder and clicking Approve.

```bash
git clone --depth 1 https://github.com/VunterSlaush/mota-extensions.git
cp -r mota-extensions/extensions/standup ~/.mota/extensions/standup
```

On Windows the destination is `%USERPROFILE%\.mota\extensions\standup`.

Then, in Mota: **Settings → Extensions → Reload list**, and the extension
appears as *Needs approval*. Click **Approve…** — a native dialog lists
what it may do — and its commands work in any chat.

Two rules the host enforces, worth knowing before you rename anything:

- The folder name must equal the manifest's `name`.
- To install an extension for one project only, drop it in that repo's
  `.mota/extensions/` instead. It arrives with the clone, and Mota flags
  its origin at consent time.

To uninstall, delete the folder and reload the list.

## Contributing an extension

Open a pull request. Two shapes are accepted:

- **Hosted here** — add `extensions/<id>/` and an entry pointing at it.
  One clone gets your extension, and review is a diff of the real code.
- **Your own repository** — add an entry pointing at a clone URL, with
  the manifest at the repository root. You keep the release cadence.

The checklist, the review criteria, and the permission rules are in
[CONTRIBUTING.md](CONTRIBUTING.md). Every pull request runs:

```bash
node scripts/validate.mjs      # the index and every manifest
node scripts/build-readme.mjs  # regenerates the catalog table above
```

No dependencies and no install step — cloning this repo is enough to run
both.

## Writing an extension

You do not have to write one by hand. In Mota, type **`/create-extension`**
in any chat and describe what you want — the command is built into every
install and scaffolds the folder, explains each permission it requested,
and tells you how to approve it.

The reference is
[`docs/EXTENSIONS.md`](https://github.com/VunterSlaush/mota-editor/blob/main/docs/EXTENSIONS.md)
in the Mota repository: the manifest, the permission vocabulary, the wire
protocol, and the declarative panel model.
[`extensions/standup`](extensions/standup) is the shortest complete
example (50 lines of plain Node);
[`extensions/github-prs`](extensions/github-prs) is the worked example for
panels — groups, badges, right-click menus and detail modals.

## What is in here

```
registry.json              the index — one entry per extension
schema/                    JSON Schema for registry.json (editor autocomplete)
extensions/<id>/           extensions hosted here: manifest, source, README
scripts/validate.mjs       the gate: index rules + every manifest rule Mota enforces
scripts/build-readme.mjs   regenerates the catalog table from the index
```

## Reading the index from an app

`registry.json` is stable and versioned; readers must ignore unknown
fields, so entries can grow without breaking anyone.

```
https://raw.githubusercontent.com/VunterSlaush/mota-extensions/main/registry.json
```

`version` is `1`. A breaking change bumps it and the old shape stays
served from a tag. Entry `permissions` are a **copy** of the manifest's,
for browsing and filtering only — an installer must re-read the real
manifest from the downloaded folder and ask for consent from *that*.

## License

The repository — index, schema, scripts — is MIT ([LICENSE](LICENSE)),
and so is every extension hosted here unless its own folder says
otherwise. Extensions listed by URL are licensed by their authors.
