# Final Scoped Re-Review

Date: 2026-10-10, Asia/Shanghai.
Workspace: `D:\CODEX\Worktree\agent-workbench-stage1\arduino-agent-agent-agent-https-ai`.
Observed HEAD: `8c4476691678986931ae47e4c8ecd6f782146d45`; review includes the current modified and untracked filesystem.

## Verdict

**Approved within the requested scope. All three previous P2 findings are addressed. No actionable new bug introduced by these fixes was found.**

This closes the three P2 findings in `final-review.md`. It is code/spec re-review approval, not certification of the final installer or rebuilt packaged artifact. The controller owns the final build, full matrix, and packaged verification.

## Scope

Read `final-fix-report.md` and inspected every listed implementation/test path: main entry, new renderer URL helper, coordinator, IPC handlers, shared contracts, App, and the URL/coordinator/App/IPC tests. Inspected the unchanged preload return path to verify the new result reaches the renderer. Also reviewed only the controller's `extraResource` addition in `forge.config.mts`.

The already-approved journal fix was not reopened. No broader feature, architecture, audit, or documentation review was performed.

## Findings Disposition

### P2-1: Windows literal-path encoding - Addressed

References: `src/main/renderer-url.ts:4-10`, `src/main/index.ts:43-50`, `tests/unit/renderer-url.test.ts:5-47`.

Packaged mode now joins the renderer resource beneath `app.getAppPath()` as a filesystem path, then applies `pathToFileURL`. Literal spaces, `#`, `%`, and percent-encoded-looking directory names are encoded before URL interpretation. The identical result is passed to loading and authorization. Development mode retains its separate entry.

The tests specify expected URL strings independently, exercise actual IPC registration, and reject added queries/fragments. Exact sender, main-frame identity, and canonical URL comparisons remain unchanged. No suffix stripping or broad authorization exception was introduced.

### P2-2: Misleading UI after journal-write failure - Addressed

References: `src/shared/contracts.ts:57-66`, `src/main/agent/run-coordinator.ts:47-61`, `src/main/ipc/register-handlers.ts:51`, `src/renderer/components/App.tsx:79-105`, `:136-149`.

The coordinator returns a narrow transient unavailable result when its storage-failure latch is set; unrelated errors still reject. The handler forwards the result and the existing preload invoke preserves it. Successful submissions still resolve without a value.

App retains the draft and transcript, displays `Unavailable` with explicit restart guidance, replaces `Streaming` with `Stopped`, and disables submission. History reload is not misrepresented as runtime repair. Persisted reducer state remains untouched and no terminal journal event is fabricated.

The tests cover storage failures before and after run start, initialization, deltas, completion, and failed-provider termination. Component cases use the actual coordinator/provider and verify preserved prior/partial text and safe guidance; the IPC regression verifies result propagation.

### P2-3: Swallowed persistence-order assertions - Addressed

Reference: `tests/unit/run-coordinator.test.ts:78-138`.

Subscriber callbacks now capture observations unconditionally; all assertions execute outside the coordinator's listener exception boundary. Both success and provider-failure cases gate every append, including initialization, deltas, and terminal events, and verify no early callbacks, complete counts/order, persistence-at-callback flags, and exact sequence prefixes. Gate release is protected by `finally`.

Inspected production `persist` at `src/main/agent/run-coordinator.ts:102-116`: `await store.append(event)` still precedes sequence advancement and listener delivery. No early-broadcast mutation or test-only production branch remains. Goodall's mutation-failure evidence is documented in the fix report; this reviewer did not rerun or reintroduce the mutation.

## Resource Addition

`forge.config.mts:17` adds only `./LICENSE` and `./THIRD_PARTY_NOTICES.md` to `packagerConfig.extraResource`. Both source files exist. The installed packager copies extra resources into its resources directory by basename; these names do not replace `app.asar`. No new runtime permission, code-loading path, or inspected configuration regression was introduced. Actual inclusion in the final artifact remains a controller build check.

## Independent Verification

Executed once, with no Electron launch:

```powershell
npx --no-install vitest run tests/unit/renderer-url.test.ts tests/unit/app.test.ts tests/unit/run-coordinator.test.ts tests/integration/ipc.test.ts tests/unit/contracts.test.ts src/renderer/state/conversation-reducer.test.ts tests/smoke/renderer-smoke.test.ts --reporter=dot
```

Result: **134 tests passed, 7 files passed**, exit 0; started 14:44:38 local time, duration 2.96 seconds.

No packaged tests, make/package commands, full-suite rerun, or installer execution were started during this re-review. Typecheck/lint and mutation results in the fix report remain author-provided evidence for this wave; the controller is running final verification. Reserved-character package relocation was not exercised here.

No application code, tests, configuration, or commits were changed. Only this requested report was manually written; the focused runner may update ignored test caches.
