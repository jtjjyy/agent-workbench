# DeepSeek Integration Implementation Plan

> **For agentic workers:** Use subagent-driven-development for disjoint modules. User explicitly waived tests and verification for this iteration; do not run tests, lint, typecheck, live API probes or review agents. Report all skipped evidence honestly.

**Goal:** Extend the approved Stage 2 vertical slice with user-configured DeepSeek streaming and cancellation.

**Architecture:** Renderer -> validated named IPC -> main-owned settings/coordinator -> Pi model adapter -> fixed DeepSeek endpoint. Model transport is reused, not reimplemented as another Agent kernel. Credentials remain outside the repository under Electron userData.

**Tech Stack:** Existing Electron 44.7.0/React 18/TypeScript scaffold, exact @earendil-works/pi-ai 1.1.0 (MIT).

## Constraints

- Existing Stage 1 journal schema and persisted-before-broadcast behavior are retained; new optional metadata is runtime validated.
- Default remains local Mock. DeepSeek requires a replacement API key and explicit data-egress consent.
- Never use or persist the credential exposed in chat. No credential in Git, environment files, events or error strings.
- Fixed HTTPS endpoint only; main-owned network requests. Keep renderer connect-src none.
- No tool loop, filesystem tools, shell, MCP or retrieval in this stage.
- No automatic request retries; bounded input/output and per-run timeout. Interrupted runs are not replayed.
- No tests or performance evidence this round. A build is a runnable artifact, not proof of correctness; do not silently run static validation through packaging.

## Implementation Tasks

- [x] Read approved design, existing contracts/runtime/renderer, and registry package metadata.
- [x] Retrieve official DeepSeek and Electron documentation; inspect current model IDs rather than assuming legacy names.
- [x] Install exact Pi dependency without install scripts or audit/test runs.
- [x] Define shared settings/credential/IPC contract.
- [x] Secure store worker: atomic serialized settings writes, OS-encrypted key, safe public view, explicit key removal, fail closed on invalid/corrupt/unavailable storage (source only).
- [x] Renderer worker: model settings dialog, password input, egress consent, actual provider label, cancellation, usage display, safe errors. Never return a stored key to renderer (source only).
- [x] Main: inspect published Pi types/source, implement streaming adapter, bounded completed-turn context, safe errors, per-run cancellation and timeout (source only).
- [x] Main: authorized read/save/delete settings IPC plus parameter-bound run cancellation; update preload and boot wiring (source only).
- [x] Update README, third-party attribution, learning mapping and unverified delivery note.
- [x] Provide development launch script in the original outputs directory. Do not run it: normal npm start invokes the scaffold's typechecker. No Stage 2 build is produced.
- [x] Synchronize existing App test fixture bridge fields for the expanded TypeScript interface. No new assertions, tests or test runs. Historical assertions may still need adjustment in a later authorized test pass.

## Deferred Acceptance Evidence

All are pending, not passed: secure-store round trip and corruption preservation; settings sender/argument rejection; adapter stream and usage; invalid key/429/timeout; cancellation during stream; late-delta suppression; journal failure; restart without request replay; packaged credential and ESM integration; desktop/mobile layout. Real API evidence requires the user's replacement credential and opt-in request.

## Risks And Boundaries

Windows DPAPI protects against other Windows users, not arbitrary processes running as the same user. JavaScript strings cannot be reliably zeroized. Encrypted credentials are machine/user-bound, not portable backups. Chat text remains plaintext in the local event journal. Cancel stops local consumption, not guaranteed provider-side billing. Model aliases and pricing may change; record request model ID and tokens, do not fabricate dollar cost. Dependency compatibility is unverified until a later authorized validation pass.

## Primary Sources Retrieved 2026-10-10

- https://api-docs.deepseek.com/ (fixed base URL and current model IDs)
- https://api-docs.deepseek.com/quick_start/pricing (model metadata; no hardcoded prices)
- https://api-docs.deepseek.com/api/create-chat-completion (stream, usage, thinking toggle)
- https://www.electronjs.org/docs/latest/api/safe-storage (protection boundaries)
- npm registry @earendil-works/pi-ai@1.1.0; installed dist source/types are the API authority.

Official DeepSeek docs currently list deepseek-flash and deepseek-v4-pro; use those IDs rather than assuming deepseek-chat/reasoner. Documentation retrieval is not a live credential/model test.
