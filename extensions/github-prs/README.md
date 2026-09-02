# GitHub PRs

Your open pull requests in Mota's sidebar, grouped by what actually needs
you rather than by repository:

1. **CI failing** — something is red
2. **Changes requested** — a reviewer is waiting on you
3. **CI running** — still moving
4. **Ready to merge** — approved and green
5. **Waiting on review** — done waiting on you
6. **Drafts**

Each row is badged with its CI status (`3/12` while checks run, the
failure count when they are red) and notes a merge conflict or a live
preview environment. Click one for the details: the failing checks by
name with links, the branch, and the review state.

**Right-click** a pull request to hide everything from that repository —
the hidden ones collect in a group at the bottom, and a click on the
delete button brings them back.

**Preview environments** are read from the *checks* on the head commit,
not from comments: a deploy bot announces the preview in both places, but
the comment gets edited and buried while the check is always the current
deploy. A live preview shows as `▶ preview` and opens from the row's
right-click menu.

## Permissions

| Permission | Why |
|---|---|
| `ui:panel` | to contribute the sidebar panel |

That is the whole list. Talking to GitHub happens in the extension's own
process, which needs no permission from Mota — the permission model
covers what an extension asks the *host* to do.

## Setup

Nothing, if you have the [`gh` CLI](https://cli.github.com) installed and
logged in (`gh auth login`) — the panel reuses that session by shelling
out to `gh api graphql`. It never reads `gh`'s credential store.

Otherwise, in order of preference:

- `GITHUB_TOKEN` or `GH_TOKEN` in your environment, or
- `{"token": "ghp_…"}` in `<dataDir>/config.json` — the panel's
  not-connected view prints the exact path.

A classic token needs `repo` (or `public_repo` for public repositories
only); a fine-grained one needs read access to pull requests and checks.

## What it touches

- **Network:** `https://api.github.com/graphql` only — one query for your
  open pull requests, and one for a single pull request's comments when
  you open a preview. Nothing else, and nothing is sent anywhere else.
- **Disk:** one file, `<dataDir>/config.json`, holding the repositories
  you hid and an optional token you put there yourself.
- **Processes:** `gh api graphql` when no token is configured.

## Requirements

Node 18+ (it uses the built-in `fetch`). No dependencies.
