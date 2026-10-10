# Agent Workbench

Local-first, single-user Windows desktop portfolio project.

## Stage 0-1

This slice uses a deterministic local Mock provider. It is not a real-model
Agent, does not integrate Pi, and has no tools, shell execution, retrieval,
MCP or network model requests. Model quality and cost are not measured.

## Development

Use Node.js 24.15.0 and npm (the lockfile fixes resolved dependencies):

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npm start
npm run package
npm run test:e2e
npm run make
```

`npm start` opens an Electron desktop window, not a browser website.
Unit/component/integration tests are separate from packaged Electron E2E.
Packaging and installer generation do not prove installation succeeded.

## Architecture And Learning

See `outputs/agent-workbench-design.md`, the approved implementation plan in
`docs/superpowers/plans/`, and `docs/learning/stage1-checkpoints.md`.

The renderer has no Node integration. Context isolation, a renderer sandbox,
local CSP and application IPC validation reduce exposed privileges; they do
not isolate arbitrary tools running in main or replace an OS execution boundary.
Storage append is not an fsync/power-loss durability guarantee.

The official Forge 8.0.1 initializer changed its CLI. The equivalent official
Webpack/TypeScript scaffold is generated with
`npx create-electron-app@8.0.1 work/forge-seed --template webpack --typescript`.
Its ESM Forge config is `forge.config.mts`, not the plan's illustrative `.ts`.
Forge-provided Webpack rules and separate renderer/main builds are retained.
Reference scaffold and tool dependencies retain their upstream licenses.

## Packaged Test And Delivery

Run `npm run package` before `npm run test:e2e`. The E2E uses the actual
Windows x64 packaged executable, not a browser or mocked IPC. Each case has
an isolated temporary profile and verifies graceful shutdown before cleanup.
Screenshots and failures are written to ignored `test-results/`.

The unpacked application is
`out/Agent Workbench-win32-x64/Agent Workbench.exe`.
Squirrel and ZIP artifacts are generated under `out/make/`.
See `outputs/stage1-delivery.md` for dated verification and known limitations.
The installer is unsigned; its creation is not an installation test.

Enter `[simulate-failure]` to exercise the documented local provider failure.
All other prompts receive a fixed echo-like Mock response. Normal launch
stores the journal under Electron's default `userData`, in
`events/conversation-v1.jsonl`. This journal contains prompt and response text
in plaintext. The renderer cannot select an arbitrary journal path.

The renderer uses `connect-src 'none'` and no model adapter performs network
requests. Dependency downloads and Chromium/OS background behavior are not a
verified application-wide network isolation boundary.

## Release Limitations

This is a portfolio development slice, not a hardened production release:

- The Node inspector fuse remains enabled for packaged Playwright automation.
- Inline styles are allowed for Webpack style-loader; inline scripts/eval are not.
- The development server binds to loopback only. The full development dependency
  tree has known audit findings; see the delivery report. Do not expose it publicly.
- Journal writes are serialized but not fsynced. Concurrent external journal
  modification, arbitrary tool rollback and power-loss survival are not promised.
- The journal is reread on append; this favors auditability over large-history
  performance in Stage 1. No performance gain is claimed.
- No user-facing cancel button, real-model credentials, tools, search, migrations,
  backups or full task recovery exist in this slice.

Original project code is MIT licensed. See `LICENSE` and
`THIRD_PARTY_NOTICES.md` for reuse boundaries and upstream licensing.
