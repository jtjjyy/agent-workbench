# Final Review Fix Report

Date: 2026-10-10 (Asia/Shanghai).
Workspace: `D:\CODEX\Worktree\agent-workbench-stage1\arduino-agent-agent-agent-https-ai`.
Status: All three P2 findings implemented and scoped verification passed.
No commit made. Controller owns the final full matrix, rebuilding, packaging,
installer generation and packaged verification of this updated source.

## Scope

Read the exact findings and reproductions in `final-review.md` before editing.
Changed only these implementation/test paths in this fix wave:

- `src/main/index.ts`
- `src/main/renderer-url.ts` (new)
- `src/main/agent/run-coordinator.ts`
- `src/main/ipc/register-handlers.ts`
- `src/shared/contracts.ts`
- `src/renderer/components/App.tsx`
- `tests/unit/renderer-url.test.ts` (new)
- `tests/unit/run-coordinator.test.ts`
- `tests/unit/app.test.ts`
- `tests/integration/ipc.test.ts`

This report is the only documentation change in this wave. The earlier
learning-checklist sidecar remains separate. Did not edit the event store,
its tests, README, preload, package files, configs or other agent-owned work.
No install, commit, build, make or Electron launch was performed in this wave.

## P2-1: Packaged Renderer URL

Main derives the packaged resource from the absolute filesystem root returned
by `app.getAppPath()`, joining `.webpack/renderer/main_window/index.html`.
The helper uses `pathToFileURL` before URL interpretation, preserving literal
spaces, hashes, percent characters and percent-encoded-looking filenames.
Main passes the same computed URL to both `loadURL` and `registerHandlers`.
The development entry remains separate and unchanged.

Five URL tests cover independently specified expected Windows URLs for
`Agent Workbench`, `name#alias`, `name%literal`, `name%20literal`, plus the
development HTTP path. Each packaged case also exercises the actual IPC
registration against the computed URL and rejects appended query and fragment
suffixes. Sender/frame/window identity checks remain unchanged; no URL
decoding or suffix stripping was added.

This verifies URL construction and authorization deterministically. It does
not claim that this agent relocated and launched a package in a reserved-
character directory; that full desktop check remains controller-owned.

## P2-2: Transient Runtime Unavailability

The necessary narrow contract addition is:

```ts
type SubmitMessageResult = void | {
  status: 'unavailable';
  code: 'JOURNAL_WRITE_FAILED';
};
```

Successful submissions still resolve with no value. The existing submit
command returns this structured outcome when the coordinator's storage-failed
latch is set. The IPC handler returns it instead of discarding it; the existing
preload invoke already forwards results and required no edit. There are no new
IPC channels, bridge operations, event kinds or event schema versions. Invalid
commands and unrelated errors still reject. The result contains no paths,
exception messages or internal diagnostics.

This addition is needed to distinguish a storage-failed runtime from an ordinary
retryable command rejection without parsing error messages or relying on custom
Error properties across IPC. Main retains the existing fail-closed storage latch
and persistence-before-broadcast behavior.

App holds runtime unavailability separately from the journal-derived reducer
state. It displays `Unavailable`, replaces `Streaming` with `Stopped`, preserves
the draft and transcript, disables submission, and displays:

`Local storage is unavailable. Restart Agent Workbench before continuing.`

History reload is not presented as a repair for this state. No fake terminal
event is synthesized or persisted. Persisted run state is left intact for normal
startup interruption handling after restart. Restart is guidance, not an
automatic disk repair or guarantee that the next launch succeeds.

Seven runtime cases inject append failure at every event type, including before
and after `run.started`, initialization and failed-provider termination. They
assert the exact safe outcome, no broadcast of the failed append, no fabricated
terminal event and no subsequent writes.

Five component cases use the real coordinator and deterministic provider with a
failing in-memory store, starting with a completed transcript. Failures at user,
run-start, agent creation, second delta and completion preserve history/draft,
stop active labels, close submission and expose safe restart guidance. The
second-delta case checks preservation of the previously persisted partial text.
One IPC regression proves the outcome reaches the command caller without an
event broadcast.

## P2-3: Persistence-Order Test

Replaced the subscriber's swallowed assertions with unconditional observation
capture. Assertions are outside the callback. Both successful and failed run
paths gate every append, including user creation, both deltas and the terminal
event. The tests assert no early callback while each gate is held.

After awaiting the operation, they assert all seven persisted and broadcast
events, full type order, contiguous sequences, persistence-at-callback flags,
and each callback's exact persisted sequence prefix. Gate cleanup is in
`finally` so an assertion failure cannot leave the submission waiting.

A temporary mutation moved delta broadcasts before append completion. Both
new tests failed outside the subscriber at the first delta: expected four
observations while its append was held, received five. The mutation was then
removed, restoring the original production await-before-broadcast ordering.
No mutation or special test behavior remains in production.

## RED / GREEN Evidence

All times below are 2026-10-10 local (+0800). Checks used the integrated dirty
workspace, not a committed delivery artifact.

1. Initial assertion RED, 14:33:01:
   `npx --no-install vitest run tests/unit/renderer-url.test.ts tests/unit/app.test.ts tests/unit/run-coordinator.test.ts --reporter=dot`
   Exit 1; 16 failed, 20 passed, 3 files; 7.44s. The importable URL placeholder
   returned the existing raw entry. Four URL cases failed expected strings;
   seven runtime cases rejected instead of returning the safe outcome; five
   component cases remained Ready/Running instead of Unavailable.
2. Boundary RED, 14:34:19:
   same command with `tests/integration/ipc.test.ts` added.
   Exit 1; 1 failed, 41 passed, 4 files; 2.35s. The handler returned undefined
   instead of the unavailable result. Fixed by returning the coordinator result.
3. Ordering mutation RED, 14:35:34:
   `npx --no-install vitest run tests/unit/run-coordinator.test.ts -t 'persists every event before broadcast' --reporter=dot`
   Exit 1; both ordering tests failed, 13 skipped; 294ms. Restored production
   append ordering immediately afterward.
4. Focused GREEN, 14:36:00:
   `npx --no-install vitest run tests/unit/renderer-url.test.ts tests/unit/app.test.ts tests/unit/run-coordinator.test.ts tests/integration/ipc.test.ts --reporter=dot`
   Exit 0; 43 passed, 4 files; 3.28s.
5. Wider scoped GREEN, 14:36:48:
   `npx --no-install vitest run tests/unit/renderer-url.test.ts tests/unit/app.test.ts tests/unit/run-coordinator.test.ts tests/integration/ipc.test.ts tests/unit/contracts.test.ts src/renderer/state/conversation-reducer.test.ts tests/smoke/renderer-smoke.test.ts --reporter=dot`
   Exit 0; 134 passed, 7 files; 3.12s.
6. `npm run typecheck` and `npm run lint`: both exit 0, no diagnostics.
7. `git diff --check`: exit 0. Git emitted only existing LF-to-CRLF conversion
   notices; no whitespace errors.
8. Final post-cleanup rerun, 14:42:19: repeated the seven-file command in item 5.
   Exit 0; 134 passed, 7 files; 3.38s. Repeated typecheck and lint alongside it;
   both exited 0 without diagnostics. A read-only whitespace check covered all
   11 fix-wave paths, including untracked files and this report, and passed.

The final matrix and packaged results must be rerun by the controller. Earlier
packaged passes and the pre-review make candidate are not evidence for this
fix wave.
