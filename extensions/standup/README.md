# Standup

Two commands for the daily update nobody enjoys writing.

- `/standup [days]` — a prompt command (pure data, no process): asks the
  agent in the current tab to summarize the last N days of work in that
  repository as what was done, what is next, and any blockers.
- `/standup-notify` — a programmatic command: the extension's script
  prepares the draft and sends you a desktop notification when it is ready.

## Permissions

| Permission | Why |
|---|---|
| `commands:register` | to contribute the two `/standup` commands |
| `notifications` | `/standup-notify` calls `host/notify` when the draft lands |

## Requirements

Node on your PATH. No dependencies, no network access, no API key.

## Reading it

`main.js` is 50 lines of plain Node and is the shortest complete example of
the wire protocol there is — one JSON object per line over stdin/stdout.
Start here if you are writing your own.
