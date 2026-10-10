# Independent Stage 0-1 Final Review

Date: 2026-10-10, Asia/Shanghai.

Verdict: **Changes requested: three P2 findings remain.** The ordinary Windows packaged workflow passes after the controller's IPC URL correction. No remaining P0/P1 issue or demonstrated privilege escalation was found. This is a filesystem review, not approval based only on committed diffs.

## Findings

### 1. [P2] Encode the packaged filesystem path before treating it as a URL

Location: `src/main/index.ts:42-44`; related normalization at `src/main/ipc/register-handlers.ts:30-33`.

The new `new URL(expectedUrl).href` correction handles backslashes and spaces, but it cannot recover literal filename characters that Forge already placed into an unescaped URL. The installed Forge implementation at `node_modules/@electron-forge/plugin-webpack/dist/WebpackConfig.js:73-75` generates `file://${require('path').resolve(...)}`. Main still passes this raw value to `loadURL`.

Confirmed with the local Node 24.15.0 URL implementation:

- A path containing `Agent Workbench` canonicalizes correctly to `Agent%20Workbench`.
- For `D:\Apps\name#alias\Agent Workbench\resources\app.asar\.webpack\renderer\main_window\index.html`, `new URL('file://' + path).pathname` is only `/D:/Apps/name`. The rest is a fragment, not the intended resource path.
- A literal directory `name%20literal` remains `%20` in that URL rather than the required `%2520`, so the resource URL describes a different filesystem name.

Consequently a valid Windows checkout or unpacked package path containing `#` or URL-like percent escapes cannot reliably load the intended renderer. Exact IPC authorization does not repair the resource path. This is a conditional launch/portability defect, not a claim that the space-only fix weakens authorization or that an exploit was demonstrated.

Required correction: construct the production renderer URL from a known absolute filesystem path with `pathToFileURL`, and use the same resulting URL for both loading and authorization. Keep the development HTTP entry separate and preserve exact sender/frame checks. Do not globally decode URLs or strip query/fragment suffixes to make authorization pass.

Regression coverage: test literal spaces, `#`, `%`, and `%20` from filesystem paths with independently specified expected URLs; retain query and fragment mismatch rejection. A packaged launch from a reserved-character directory would verify the complete path. I reproduced URL interpretation directly, but did not relocate and launch the package under such a directory.

Requirement basis: Stage 0 reproducible Windows launch and Stage 1 packaged local renderer. This is a correctness finding, not a request for a new capability.

### 2. [P2] A journal write failure leaves the UI falsely running without recovery guidance

Location: `src/renderer/components/App.tsx:98-102`; related status/disable logic at `:78-83` and recovery action at `:141-146`; runtime failure behavior at `src/main/agent/run-coordinator.ts:101-105`.

After `run.started` has been persisted, a failure writing the agent-created event, any delta, or completion sets `storageFailed` and rejects the submission without broadcasting an unpersisted terminal event. That fail-closed persistence behavior is appropriate. However, App replaces the actionable runtime error with only `Could not send message.`, leaves `activeRunId` intact, and offers no recovery action. It indefinitely displays `Running`, keeps the composer disabled, and may leave an assistant message labelled `Streaming` even though the provider has stopped. Reloading history alone does not fix this because `readConversation` reuses the initialized, storage-failed coordinator.

Confirmed using the actual coordinator, deterministic provider, reducer, and React App in an in-memory Node/jsdom harness, injecting append failure on `message.agent.delta`:

```json
{"status":"Running","error":"Could not send message.","inputDisabled":true,"reloadActionPresent":false,"persistedTypes":["conversation.created","message.user.created","run.started","message.agent.created"]}
```

An earlier append failure instead leaves the UI apparently `Ready`, although every future submission is rejected until process restart.

Required correction: represent the runtime-unavailable outcome separately from persisted conversation events, stop claiming the run is active, and give safe explicit application-restart guidance while preserving the draft and transcript. Do not fabricate a persisted `run.failed` event when storage failed. Add component/runtime coverage for write failure before and after `run.started`.

Requirement distinction: automatic disk repair or continued operation after storage failure is not required by Stage 1. Truthful failure status and an actionable recovery path are the bug here; no fsync or production crash-recovery requirement is being added.

### 3. [P2] The persistence-order unit test can swallow its own failed assertions

Location: `tests/unit/run-coordinator.test.ts:85-96`; exception isolation in `src/main/agent/run-coordinator.ts:108-109`.

The subscriber executes `expect(written).toContain(event)` before recording the broadcast. The coordinator intentionally catches subscriber exceptions. An early-broadcast regression therefore swallows the assertion and also omits the event from `published`. The outer assertions only require no recorded broadcasts while the user append is gated and a final `run.completed`, so early delta broadcasts can go undetected.

Confirmed with a runtime-only mutation, without editing any source or test file: for delta events, defer the fake store's visibility until after the coordinator invokes its listeners. All existing outer test conditions still pass, with seven listener assertion failures suppressed, twelve stored events, and only four recorded broadcasts. This demonstrates a false-positive ordering test, not a current production persistence-order violation.

Required correction: capture every callback observation without asserting inside the callback; assert persistence-at-callback flags, event count, and full event order outside the subscriber after the awaited operation. Gate/check more than just the user event, including deltas and terminal events.

Requirement basis: persistence-before-broadcast is an explicit global invariant. The packaged E2E observes journal presence after renderer-to-runner delivery and an asynchronous disk read; it is useful evidence but cannot replace a deterministic timing test at the coordinator boundary.

## Controller URL Fix Reviewed

- Reviewed the updated `register-handlers.ts` and new integration regression directly from disk.
- `new URL(expectedUrl).href` correctly fixes the observed raw Forge Windows URL versus Chromium canonical URL mismatch for the current path with spaces.
- Known WebContents identity, exact main-frame identity, destroyed-window rejection, and exact canonical URL comparison remain intact.
- The regression verifies successful read/submit/event delivery and rejects an appended query. It also independently checks the expected canonical space-containing URL string.
- The original all-IPC-rejected defect is **fixed for the tested package** and is not counted as an open finding. Finding 1 concerns a separate literal-path encoding case.

## Verification Performed

Workspace: `D:\CODEX\Worktree\agent-workbench-stage1\arduino-agent-agent-agent-https-ai`.

Base: `225fe7a`. Observed HEAD: `8c4476691678986931ae47e4c8ecd6f782146d45`, including the event-store commit `ab005a8`. Much of the scaffold/runtime/E2E remains untracked. The controller changed files concurrently; this report incorporates the URL fix and the subsequent packaged artifact.

Read the approved plan and design, all current `src/` implementation, unit/component/integration/E2E tests, package metadata, Forge/Webpack/TypeScript/lint/test configurations, README, and learning scope. Inspected the rebuilt ASAR main bundle to confirm it includes URL normalization.

Independent command results:

| Check | Result |
| --- | --- |
| `node --version` | `v24.15.0` |
| `npm run typecheck` after URL fix | Passed |
| `npm run lint` after URL fix | Passed |
| `npm test` before URL regression | 173 passed, 8 files |
| `npm test` after URL regression | 174 passed, 8 files |
| `npm run test:e2e -- --output=work/review-e2e` against earlier package | 3 failed after real application launch: startup remained `Unavailable` |
| `npm run test:e2e -- --output=work/review-e2e-postfix` against rebuilt package | 3 passed in 10.2 seconds |
| In-memory failure-path probes | Confirmed finding 2 |
| In-memory ordering-test mutation | Confirmed finding 3 |
| Windows filesystem-path/URL probes | Confirmed finding 1 interpretation |

Packaged executable exercised: `out/Agent Workbench-win32-x64/Agent Workbench.exe`. E2E used separate temporary profiles, actual packaged runtime/renderer checks, live streaming, provider failure and subsequent success, duplicate request checks, and exact transcript/journal restoration across orderly restart. The successful suite closed its processes and completed fixture cleanup.

Reviewed generated screenshots under `work/review-e2e-postfix/` at 1280x800 and 600x480 content sizes. Main sections and controls remained visible without observed overlap; narrow trace labels wrap.

No application code, test source, configuration, or commits were changed by this reviewer. Only this requested report was manually written; test runners generated ignored caches/results/screenshots.

## Acceptance And Limits

- Deterministic provider, narrow validated IPC, main-owned sequence/idempotency, serialized JSONL writes, strict complete-record replay, persistence-before-notification implementation, startup subscription buffering, reducer ordering, and safe React text rendering are present.
- Completed conversation restore and provider-failure recovery are demonstrated by real packaged E2E, not represented by component mocks.
- I did not rerun `npm ci`, `npm run package`, `npm run make`, or execute an installer. Packaging was controller-owned. Artifact execution is verified; clean-checkout install and installer generation/installation are not independently certified here.
- README still lacked `npm run test:e2e`, exact artifact paths, and final evidence when read. Task 5 explicitly requires these closeout updates; treat them as pending documentation requirements, not speculative runtime defects.
- No whole-process network audit was performed. Source/provider inspection and CSP are not a proof of zero Chromium background network activity.
- Accepted exceptions are not findings: inspector fuse enabled for Stage 1 Playwright, style-loader inline-style CSP accommodation, no per-event fsync, O(n) journal reread per append, and the user-reported dev audit 9/prod audit 0. The audit counts were not independently rerun.
- No real-model, tools, retrieval, credentials, MCP, or later-stage recovery requirements were introduced.
- Optional hardening, not an acceptance blocker: cap idempotency-key size and pending submission queue growth against a compromised renderer; broaden negative packaged sender tests and explicit network-denial evidence.
- External documentation lookup returned no usable content during this review. No unavailable external review service or online validation is claimed; findings rely on inspected local implementation, installed tool sources, and executed probes/tests.

## Final Store-Fix Follow-Up

The controller subsequently requested review of Kant's corruption-classification correction. Reviewed the latest `src/main/events/event-store.ts:16-55` and added tests in `tests/unit/event-store.test.ts` directly from disk.

The previous EOF-message heuristic could classify a malformed unfinished string as a recoverable tail, permitting its bytes to be truncated on the next append. The correction additionally scans string contents for raw control characters, invalid escape letters, and nonhex Unicode escape digits; it also compares parser positions against the actual text length rather than `trimEnd().length`. It preserves incomplete-but-valid escape prefixes.

The new regression cases check replay rejection, append rejection without truncating bytes, completed/middle corruption, and recovery of every byte prefix of a valid record containing escaped and multibyte strings. I found no additional actionable defect in this change. The original malformed-string issue is treated as fixed in the inspected source, not as a fourth open finding.

Fresh independent checks after this change:

- `npm test`: **199 passed, 8 files**, duration 5.29 seconds, started 14:24:28 local time.
- `npm run typecheck`: passed.
- `npm run lint`: passed.

The three passing packaged E2E results above were obtained before this final store correction. The controller separately reported three genuine packaged E2E passes in 9.2 seconds after the URL and saved-child cleanup fixes. Neither result is represented as packaged verification of the subsequently changed store. Repackage and rerun E2E against the final source before claiming final-artifact acceptance.

Final verdict remains **three P2 changes requested**, with no remaining P0/P1 established. No production/test/config edits or commits were made by this reviewer.
