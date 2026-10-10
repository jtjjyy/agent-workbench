# Stage 0-1 Learning Checkpoints

Date: 2026-10-10

Scope: the approved local Windows desktop vertical slice, not a complete Agent.
One conversation (`default`) accepts a prompt, streams a deterministic local
response, persists versioned events, restores a completed transcript after
relaunch, and displays a timestamped event trace.

Source of requirements:

- `outputs/agent-workbench-design.md`, especially sections 4, 5, 6, 8 and 9.
- `docs/superpowers/plans/2026-10-10-agent-workbench-vertical-slice.md`,
  especially Tasks 1-5 and Learning Checkpoints.

## Status and Labels

This document is a learning checklist with attributed implementation evidence,
not the final delivery report. Module and configuration paths below have been
reconciled with the current code. The controller owns the planned
[Stage 1 delivery report](../../outputs/stage1-delivery.md) records final artifact
identity, verification and known limits.

Final controller evidence on 2026-10-10:

- Controller reports successful `npm ci`.
- Final typecheck and lint passed. Final full Vitest run passed 217 tests
  across 9 files; a second JSON-report run also passed.
- Final `npm run make` exited 0, rebuilding the package and generating
  Windows Squirrel and ZIP artifacts after all review fixes.
- Final `npm run test:e2e` passed all 3 cases in 8.8 seconds against that
  package. This is real packaged Electron evidence with a Mock provider.
- Controller viewed final 1280x800 and 600x480 screenshots. A separate
  real packaged launch in a directory containing spaces, `#` and `%20`
  passed a prompt, journal comparison and zero-exit shutdown.
- Independent scoped re-review approved all three review corrections.
- Installer generation is verified; installation/upgrade/uninstall remain
  untested. No fresh-clone installation claim is made from `npm ci` alone.

This documentation sidecar reads code and reconciles evidence; it does not
rerun installation, tests, packaging, or learner exercises. Agent/controller
execution is not evidence that the learner personally implemented or
understands the application. L0-L7 remain NOT PERFORMED / NOT VERIFIED.

- **[MAINLINE]**: required Stage 0-1 implementation or acceptance work.
- **[INDEPENDENT EXPERIMENT]**: learner-owned, disposable investigation using
  isolated fixtures or a controller-approved scratch branch; not a new product
  feature or an acceptance substitute.
- **[PRINCIPLE LEARNING]**: explain the reason and limits of a design decision.
  An explanation is not evidence that the control works in the packaged app.

Real models, Pi integration, tools, arbitrary filesystem access, shell commands,
MCP, retrieval, multiple sessions, cancellation UX and multi-agent orchestration
remain outside this slice. The provider's `AbortSignal` interface alone does not
prove end-to-end cancellation support.

## Actual File Map

The current implementation follows the plan's logical boundaries, with these
actual filenames and test lanes:

| Responsibility | Actual paths / entry points |
|---|---|
| Toolchain and static checks | `.nvmrc`, `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.mjs` |
| Forge and Webpack | `forge.config.mts`, `webpack.main.config.ts`, `webpack.renderer.config.ts`, `webpack.rules.ts`, `webpack.plugins.ts` |
| Test discovery | `vitest.config.mts` for unit/integration/smoke; `playwright.config.mts` for packaged E2E |
| Shared contracts and journal | `src/shared/contracts.ts`; `src/main/events/event-store.ts` exports `JsonlEventStore` |
| Local Mock runtime | `src/main/agent/provider.ts` exports `createDeterministicProvider`; `src/main/agent/run-coordinator.ts` exports `RunCoordinator` |
| Trusted desktop boundary | `src/main/index.ts`; `src/main/ipc/register-handlers.ts` exports `registerHandlers`; `src/preload/index.ts` |
| Isolated E2E launch options | `src/main/e2e-options.ts` exports `resolveTestUserData`; explicit `--awb-e2e` and one absolute `--awb-user-data=...` |
| Renderer entry and contracts | `src/renderer/index.html`, `src/renderer/main.tsx`, `src/renderer/agent-api.d.ts`, `src/renderer/styles.css` |
| Renderer state and views | `src/renderer/state/conversation-reducer.ts`; `src/renderer/components/App.tsx`, `Composer.tsx`, `EventTrace.tsx` |
| Unit and integration tests | `tests/unit/contracts.test.ts`, `event-store.test.ts`, `run-coordinator.test.ts`, `e2e-options.test.ts`, `app.test.ts`; `src/renderer/state/conversation-reducer.test.ts`; `tests/integration/ipc.test.ts` |
| Renderer smoke and packaged E2E | `tests/smoke/renderer-smoke.test.ts`; `tests/e2e/conversation.e2e.ts` |

`npm test` runs Vitest; it does not run packaged E2E. `npm run test:e2e` runs
Playwright against the packaged Windows executable. Forge's `main_window`
entry combines the renderer HTML/React entry with the preload entry; package
metadata points to `.webpack/main/index.cjs`. These paths are not the plan's
alternative `forge.config.ts` or `vitest.config.ts` filenames.

## Knowledge to Interview Mapping

The table identifies the evidence needed for each claim. Current results and
remaining gaps are attributed in the V0-V9 ledger below; a listed requirement
is not itself a completed test or personal learner record.

| Label / knowledge | Product requirement | Implementation module | Required test evidence | Interview question |
|---|---|---|---|---|
| [MAINLINE] Reproducible toolchain | Another checkout can install, check and launch the desktop shell | `.nvmrc`, `package.json`, `package-lock.json`, `forge.config.mts`, `tsconfig.json`, `webpack.*.ts`, `README.md` | V0: clean `npm ci`, checks and actual launch on the pinned Node baseline | What does the lockfile pin, and why is host Node compatibility distinct from Electron's embedded runtime? |
| [MAINLINE] Runtime contracts | Reject malformed IPC data rather than trusting TypeScript | `src/shared/contracts.ts`; `src/main/ipc/register-handlers.ts` | V1/V4: valid input, wrong types, empty key, blank prompt, 20,000 UTF-16 code-unit boundary and over-limit input | Why do shared types not validate data crossing a process boundary? |
| [MAINLINE] Process ownership and least privilege | Renderer uses only named application operations | `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/agent-api.d.ts` | V4/V7: sender/frame/local-URL rejection, unknown channels, narrow bridge, packaged renderer cannot access `window.require` or `window.process` | Why must main validate a request even when the composer already validates it? |
| [MAINLINE] Versioned events | Trace and replay one conversation consistently | `src/shared/contracts.ts`; `src/main/agent/run-coordinator.ts` | V1/V3: all seven event types, schema version, unique event IDs and increasing per-conversation sequence | Why use both an event ID and a conversation sequence? |
| [MAINLINE] Serialized JSONL persistence | Whole ordered records can be replayed after reopening | `src/main/events/event-store.ts` | V2: round-trip, conversation filtering, concurrent appends, malformed middle record, partial final record | Why can a partial final fragment be ignored but a malformed earlier record cannot? |
| [MAINLINE] Persist before broadcast | Visible committed events can be reconstructed from the journal | `src/main/agent/run-coordinator.ts`; `EventStore.append` | V3: blocked append prevents publication; append rejection never publishes that event | What does awaiting append prove, and what does it not prove about sudden power loss? |
| [MAINLINE] Idempotent submission | A repeated `clientRequestId` creates at most one run | Coordinator initialization/submit; `App.tsx` pending request ref | V3/V5: duplicate submission during a run and after journal replay; one user event and one run; pending request guard | How are deduplication keys reconstructed after restart, and why is this not exactly-once execution for arbitrary tools? |
| [MAINLINE] Streaming adapter | Incremental output works locally without model credentials | `src/main/agent/provider.ts`; coordinator | V3: multiple deterministic deltas, reconstructed fixed response, injected provider failure | Which behavior can a deterministic provider validate, and which real-provider problems remain untested? |
| [MAINLINE] Pure event reducer | Transcript and trace are derived from the same ordered history | `src/renderer/state/conversation-reducer.ts` | V5: correct delta target, duplicate sequence ignored, gap requires reload, immutable inputs, terminal states | Why derive view state from events instead of several unrelated callbacks? |
| [MAINLINE] Subscription lifecycle | Live events arriving during startup are not lost or doubled | `src/renderer/components/App.tsx`; preload `onEvent` | V4/V5: subscribe before history read, buffered overlap merged by sequence, exact listener disposal | What race exists between loading history and subscribing, and how do you close it? |
| [MAINLINE] Observable recoverable failures | Retain the user message, record failure and allow another prompt | Coordinator, reducer, `App.tsx`, `Composer.tsx`, `EventTrace.tsx` | V3/V5/V6/V7: `run.failed` persists, active state clears, next submission works, ordered timestamped trace | How does a failed run differ from a missing event or journal corruption? |
| [MAINLINE] Packaged restart verification | Completed messages and event order restore after quit/relaunch | `tests/e2e/conversation.e2e.ts`; `playwright.config.mts`; `forge.config.mts`; `src/main/e2e-options.ts` and `src/main/index.ts` | V7/V8: real packaged executable, isolated journal, completion, quit and relaunch, recorded Windows artifacts | Why does a mocked renderer test not prove Electron IPC, preload or restart persistence? |
| [PRINCIPLE LEARNING] Honest security and reliability claims | Do not describe UI controls as arbitrary-code containment or orderly restart as crash recovery | Main/preload boundary; storage and scope documentation | V3/V4/V7 plus written limitations; no OS tool-isolation evidence in this slice | What additional boundary would side-effecting tools require, and what does Stage 1 deliberately not prove? |

Expected prompt path to explain without reading a prepared answer:

`Composer -> window.agent.submitMessage -> preload -> validated main IPC ->
RunCoordinator -> journal append -> deterministic provider -> append each delta
-> event broadcast -> renderer reducer -> transcript and trace`.

Startup additionally reads the journal, reconstructs sequence and request keys,
and merges replay with buffered live events. Storage is owned by main under
Electron `userData`, not exposed as arbitrary renderer file access.

## Beginner Exercises Personally Performed by the Learner

These are instructions for future hands-on work. **Every exercise is currently
NOT PERFORMED / NOT VERIFIED.** The learner, not an assistant, must perform and
explain the work before changing that status. Assistant-written code or a
controller's test run cannot be recorded as the learner's personal exercise.
This sidecar only writes this checklist; it does not make the exercise changes.

| Checkpoint | Label | Learner-owned action | Evidence to record personally |
|---|---|---|---|
| L0: after Task 1 | [MAINLINE] | Use the pinned Node baseline; run the documented install/check/start scripts, identify main/preload/renderer, and make one small typed UI change with controller coordination | Actual commands and exit codes, screenshot of changed UI, changed diff, and an explanation of which process rendered it |
| L1: before Task 2 | [PRINCIPLE LEARNING] | Explain what happens if an IPC object has a numeric `text` or missing request key despite the compile-time interface | Own explanation and the actual validator test/case reference; do not bypass validation |
| L2: after Task 2 | [INDEPENDENT EXPERIMENT] | In a temporary test directory, compare a truncated final JSONL fragment with malformed JSON in a middle newline-terminated record | Fixture contents, exact focused test command and output, observed difference; never corrupt real app data |
| L3: after Task 3 | [MAINLINE] | Trace one prompt, repeat a request with the same key in an isolated test, then inspect the journal and event order | Sequence/type trace and count of user/run events, plus explanation of persistence before publication |
| L4: after Task 4 | [MAINLINE] | Independently extend the reducer with a small derived terminal-status view (no new event type), write a focused assertion, and diagnose a replay failure | Personal diff, behavioral failing assertion and diagnosis, corrected test output, and why replay and live events produce the same view |
| L5: after Task 4 | [INDEPENDENT EXPERIMENT] | Replay isolated fixtures with a duplicate sequence and a missing sequence; optionally delay history loading while delivering an overlapping live event in a test harness | Expected state written before execution, actual state/output, and diagnosis of duplicate suppression versus reload-required gaps |
| L6: after Task 5 | [MAINLINE] | Personally run the packaged restart E2E and inspect restoration; distinguish the unpacked executable from a generated installer | Package path, actual E2E report, same isolated user-data directory used twice, screenshot or trace, and explicit crash-recovery limitations |
| L7: stage close | [PRINCIPLE LEARNING] | Explain Mock versus real model, renderer sandbox versus OS tool isolation, and which work was assistant-assisted | Own short explanation tied to implementation/test references, unresolved questions and accurate contribution statement |

Use a separate completed record for each exercise; leave placeholders unfilled
until the learner actually performs it:

```text
Exercise ID / label: <L0-L7; exact label>
Status: NOT PERFORMED
Learner / date: <unfilled>
I personally performed: <unfilled; concrete actions, not copied instructions>
Assistant/controller contribution: <unfilled>
Expected behavior before running: <unfilled>
Actual commands / environment / exit codes: <unfilled>
Observed result or failing assertion: <unfilled>
My diagnosis and explanation: <unfilled>
Personal diff / log / screenshot / test-case reference: <unfilled>
Limitations and remaining questions: <unfilled>
```

For L4, an import/setup error is not a meaningful behavioral RED result. Identify
the failed assertion, find the faulty event transition or replay assumption,
and retain the before/after evidence. Use an isolated fixture or scratch branch
for a deliberate fault; do not break the controller's active implementation.

## Evidence Ledger

Commands and paths below match the implementation. Successful results are
attributed to their operator; pending or unavailable evidence stays explicit.
None of these results completes a learner exercise.

| ID | Evidence lane | Command or observation | Attributed status as of this snapshot |
|---|---|---|---|
| V0 | Environment/static/development smoke | `node --version`; `npm ci`; `npm run typecheck`; `npm run lint`; `npm test`; `npm start` | Controller: Node 24.15.0; install/typecheck/lint passed; final full suite 217 passed. Development shell launched and closed earlier. A separate fresh Git clone was not installed. |
| V1 | Deterministic unit | `npx vitest run tests/unit/contracts.test.ts` | Passed within the final controller 217-test full run; detailed assertions are in its JSON report. |
| V2 | Deterministic unit with isolated real filesystem fixture | `npx vitest run tests/unit/event-store.test.ts` | Journal agent: 80 passed after malformed-tail correction; final controller full run includes these cases. Exhaustive byte-prefix IO case has a local 30-second timeout. |
| V3 | Deterministic coordinator test with local Mock provider and journal | `npx vitest run tests/unit/run-coordinator.test.ts` | Final full run passed, including each append failure and externally asserted append-before-broadcast observations. A temporary ordering mutation was detected and removed. This is Mock/runtime evidence, not real-model evidence. |
| V4 | IPC integration, including harness limits | `npx vitest run tests/integration/ipc.test.ts` | Final full run includes URL authorization and transient unavailable-result forwarding regressions. A simulated sender is not packaged Electron proof. |
| V5 | Pure reducer/component tests | `npx --no-install vitest run src/renderer/state/conversation-reducer.test.ts tests/unit/app.test.ts tests/smoke/renderer-smoke.test.ts` | Final full run includes the original renderer cases and five storage-failure App regressions using the actual coordinator. RED/GREEN recorded by renderer/fix agent. Component tests do not prove desktop layout or IPC. |
| V6 | Development desktop manual observation | `npm start`; inspect incremental text, failure recovery, trace and 1280x800 layout | No separate development manual-check result supplied. Packaged automated observations belong to V7, not this lane. |
| V7 | Packaged Electron E2E with Mock provider | `npm run package`; `npm run test:e2e` | Controller: final make rebuilt the package; all 3 packaged tests passed in 8.8s after all fixes. Final screenshots inspected at 1280x800 and 600x480. A separate reserved-character-path packaged probe also passed. |
| V8 | Windows artifact generation | `npm run make`; record actual executable/installer paths and build output | Controller: exit 0; Squirrel Setup and ZIP generated. Paths/hashes are in the delivery report. Installer is unsigned and has not been installed. |
| V9 | Opt-in real-model lane | None in Stage 0-1 | OUT OF SCOPE; no credentials, provider request, usage or model-quality result |

Renderer agent execution details: 2026-10-10, Windows workspace; focused V5
started at 13:59:22 +0800 (2.98s), full Vitest at 13:59:23 +0800 (2.94s).
Typecheck and lint both returned 0 without diagnostics. These checks ran
before the renderer commit `8c4476691678986931ae47e4c8ecd6f782146d45`
(`feat: add streamed conversation workbench`) against the then-integrated
dirty worktree, not a fully committed delivery tree. Detailed renderer
evidence is retained in the local workflow report
`.superpowers/sdd/2026-10-10-agent-workbench-vertical-slice/task-4-report.md`.

Final controller verification supersedes the earlier renderer snapshot, while
preserving its RED/GREEN provenance. See the
[delivery report](../../outputs/stage1-delivery.md) and its evidence directory
for final logs and artifact identity. None of these runs completes a learner
exercise or proves real-model behavior.

For the final report, record: operator, date, commit or dirty-diff identity,
host OS/architecture, Node/Electron versions, exact command, exit code, case
counts and failures, raw log/report path, and fixture/artifact identity.
Record failure or blocked status honestly. For E2E also record the actual
executable and isolated user-data directory, launch/quit/relaunch sequence,
assertions and report. Do not put credentials or raw sensitive app data in
evidence. A screenshot supports observation, not an unexecuted automated test.

## Boundaries to Explain

### Mocked Provider Versus Real Model

The local deterministic implementation exercises the implemented `AgentProvider`
interface and emits predictable chunks. It is an application test double,
not an LLM, model reasoning, autonomous Agent loop or Pi integration. The
provider contains no network calls in this slice;
installing dependencies is a separate development activity.

The passed Mock tests support their tested application ordering, replay, failure
handling and IPC behavior. They do not measure answer quality, provider compatibility,
token/cost usage, rate limits, credential safety, remote data disclosure or
real-model cancellation. A packaged E2E can be genuine end-to-end desktop
evidence while still using a Mock provider; label both dimensions.

Stage 2 would add an explicitly configured real-model adapter with disclosure,
credential handling and opt-in live tests. Those future tests require model
identifier/configuration and actual request outcomes; Stage 1 cannot claim them.

### UI Sandbox Versus OS Tool Isolation

The current `src/main/index.ts` enables `contextIsolation`, `sandbox`,
`nodeIntegration: false` and `webSecurity`. `src/renderer/index.html` supplies
the local-content CSP; `forge.config.mts` also sets the development CSP.
These renderer controls,
the named preload bridge and main-side sender/payload validation reduce the
UI's privileged surface. Runtime tests must verify the bridge and actual
packaged renderer; merely listing configuration values is not sufficient.
V4 records controller-reported harness evidence, and V7 records the
controller-reported three-test packaged pass including isolation. That snapshot
does not establish the outcome of the pending post-correction rerun.

Electron's renderer sandbox is a renderer-specific boundary. It does not
isolate arbitrary tools run by the privileged main process, provide an
application-wide filesystem/network/process sandbox, or turn approval dialogs
into OS isolation. No tool executor exists in this slice, so there is no
evidence of workspace path enforcement, shell containment or safe rollback.

Before future side-effecting tools, the product would need separately tested
authorization, canonical parameter-bound approvals, path boundaries, timeouts,
cancellation, output limits and uncertain-state recovery. Where stronger
containment is required, an explicitly configured OS/container execution
boundary must be evaluated independently. Do not claim those controls now.

### Orderly Restart Versus Crash Durability

`JsonlEventStore.append` serializes journal operations, awaits the append write
and closes the file handle; the coordinator awaits append before publishing.
The implementation does not force an `fsync`
per event, so this is not a sudden-power-loss durability guarantee. Ignoring
an incomplete trailing JSON object without a terminating newline is not permission to
ignore malformed complete records or invalid envelopes.

The restart E2E concerns a completed conversation and orderly quit/relaunch.
It does not prove arbitrary crash recovery, automatic replay of side
effects, migrations, backup restoration or rollback. No tool side effects
exist here, and reconstructed idempotency keys do not establish arbitrary-tool
exactly-once execution. The coordinator does mark an unfinished restored run
as `run.failed` / `RUN_INTERRUPTED` without rerunning it; that implemented
transition is not a guarantee of recovery from every interruption or power loss.

## Stage Closeout

Only reconciliation and evidence-lane bookkeeping are checked below. Delivery
acceptance, final post-correction evidence and learner performance remain separate:

- [x] Actual module paths have been reconciled with the implementation.
- [x] V0-V8 have attributed results or explicit pending/not-supplied status.
- [ ] L0-L7 have personal learner records, not assistant completion claims.
- [x] Mock, unit/integration, manual and packaged E2E evidence remain distinct.
- [ ] Interview answers explain both the implemented behavior and its limits.
- [ ] Contribution statements separate assistant scaffolding from personal work.

An eventual interview statement may describe a persisted, streamed local desktop
conversation only after attaching implementation and execution evidence. Do not
claim a self-built Agent kernel, real-model integration, production adoption,
measured performance gains, arbitrary-tool isolation or guaranteed recovery
from this slice.
