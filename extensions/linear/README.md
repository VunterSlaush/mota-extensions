# Linear

Your assigned Linear issues in Mota's left sidebar: grouped by status,
with the status changeable inline from a dropdown, and a click on any
issue opening its details.

The panel is declarative — the extension answers with a view model and
Mota renders it with its own components, so it is themed like the rest of
the app and no extension code runs in the window.

## Permissions

| Permission | Why |
|---|---|
| `ui:panel` | to contribute the sidebar panel |

That is the entire list. The extension talks to Linear's API from its own
process, which needs no permission from Mota — the permission model covers
what an extension may ask the *host* to do.

## Setup

Click **Log in** in the panel: it walks you through creating a Linear
OAuth application once, then it is one click forever. Tokens land in the
extension's own `dataDir` and are refreshed automatically.

A personal API key works as a fallback — put `{"apiKey": "lin_api_…"}` in
`<dataDir>/config.json`, or set `LINEAR_API_KEY` in your environment.

## Requirements

Node on your PATH. No dependencies.

## Reading it

`main.cjs` is the worked example for panels: `panel/load` answers with
groups and items, `panel/action` handles `open`, `select` and `button`,
and `panels/refresh` tells the host to re-pull after a slow sign-in.
