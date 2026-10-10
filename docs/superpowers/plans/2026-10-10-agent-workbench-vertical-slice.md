# Agent Workbench Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first runnable Windows desktop slice: a user submits a prompt, sees a deterministic response stream, closes the app, and sees the persisted transcript after relaunch.

**Architecture:** Use Electron Forge with TypeScript and React. The Electron main process validates IPC, coordinates a deterministic provider, writes a versioned JSONL event journal under `app.getPath('userData')`, then forwards persisted events to the renderer. The renderer has no direct Node or filesystem access and derives conversation state from events.

**Tech Stack:** Node.js 24.15.0 (local baseline), Electron Forge, Electron, TypeScript, React, React DOM, Webpack, Vitest, Playwright Electron API for end-to-end coverage. Pin resolved package versions in `package-lock.json`; do not use floating dependency ranges for shipped runtime dependencies.

## Global Constraints

- Product requirements and non-goals are defined in `outputs/agent-workbench-design.md`; this plan implements only Stages 0 and 1.
- Use Node.js `24.15.0` for the project baseline; commit `.nvmrc` containing `24.15.0` and declare the matching package engine floor.
- Use the official Electron Forge TypeScript + Webpack template; initialize the lockfile and commit it.
- Enable `contextIsolation`, `sandbox`, and `nodeIntegration: false`; keep `webSecurity` enabled and add a restrictive local-content CSP.
- Expose only named, typed methods from preload. Validate the IPC sender, command payload, text length, and idempotency key in the main process.
- Persist each event before broadcasting it. Do not persist credentials or use a real model in this slice.
- Keep the provider deterministic and local; the app runtime makes no network requests and has no tools, shell, arbitrary file access, MCP, or autonomous planning.
- JSONL replay may ignore one malformed trailing partial record only; malformed earlier records must fail visibly.
- Tests must distinguish unit, integration, and packaged Electron E2E. Never report an E2E result from a mocked renderer test.
- Preserve the existing `outputs/agent-workbench-design.md`; do not rewrite or move it as part of setup.

---

## File Map

| Path | Responsibility |
|---|---|
| `.nvmrc` | Project Node.js version |
| `.gitignore` | Exclude dependencies, build output, logs, local app data, scratch work and secrets |
| `README.md` | Install, run, test, package commands; stage scope and limitations |
| `package.json`, `package-lock.json` | Scripts, pinned dependency graph and Node engine floor |
| `eslint.config.mjs` | Flat ESLint configuration for source and test files |
| `forge.config.ts` | Electron Forge makers, Webpack plugin and package metadata |
| `webpack.*.ts` | Separate main, renderer and preload build entries |
| `tsconfig.json`, `tsconfig.*.json` | TypeScript settings per process target |
| `src/shared/contracts.ts` | Event and IPC request/response types plus runtime validators |
| `src/main/events/event-store.ts` | Append-only JSONL event journal and replay |
| `src/main/agent/provider.ts` | Provider interface and deterministic local implementation |
| `src/main/agent/run-coordinator.ts` | Idempotent submit, run lifecycle, persistence-before-broadcast |
| `src/main/ipc/register-handlers.ts` | Validated commands, sender checks and event subscriptions |
| `src/main/index.ts` | Window lifecycle and process wiring |
| `src/preload/index.ts` | Narrow `contextBridge` API |
| `src/renderer/index.html` | Local renderer document and CSP |
| `src/renderer/main.tsx` | React application entry |
| `src/renderer/agent-api.d.ts` | Type declaration for the allowed preload bridge |
| `src/renderer/state/conversation-reducer.ts` | Pure event-to-view-state reducer |
| `src/renderer/state/conversation-reducer.test.ts` | Reducer ordering, delta, event trace, duplicate and terminal-state tests |
| `src/renderer/components/App.tsx` | Conversation layout and event subscription lifecycle |
| `src/renderer/components/Composer.tsx` | Prompt input, submit, pending and error states |
| `src/renderer/components/EventTrace.tsx` | Read-only ordered event timeline with type, time and sequence |
| `src/renderer/styles.css` | Compact desktop workbench styling |
| `tests/smoke/renderer-smoke.test.ts` | Renderer root smoke test |
| `tests/unit/contracts.test.ts` | Runtime validation of IPC and event data |
| `tests/unit/event-store.test.ts` | Journal append, replay, serialization and corruption tests |
| `tests/unit/run-coordinator.test.ts` | Provider lifecycle, event ordering and idempotency tests |
| `tests/integration/ipc.test.ts` | IPC payload/sender validation and event delivery |
| `tests/e2e/conversation.e2e.ts` | Packaged Electron launch, stream, quit and relaunch restore |
| `vitest.config.ts` | Unit/integration test discovery and environments |

The generated Forge template may use different filenames. During Task 1, map the generated files to these responsibilities and update this file map in the implementation notes if a template-specific path differs. Do not duplicate configuration solely to match the proposed names.

## Shared Interfaces

The following types are the contract across tasks. Runtime validation is required at IPC and storage boundaries; TypeScript types alone do not validate untrusted runtime values.

```ts
export type EventType =
  | 'conversation.created'
  | 'message.user.created'
  | 'run.started'
  | 'message.agent.created'
  | 'message.agent.delta'
  | 'run.completed'
  | 'run.failed';

export type EventPayloads = {
  'conversation.created': { title: string };
  'message.user.created': {
    messageId: string;
    clientRequestId: string;
    text: string;
  };
  'run.started': { runId: string; sourceMessageId: string };
  'message.agent.created': { messageId: string; runId: string };
  'message.agent.delta': { messageId: string; runId: string; text: string };
  'run.completed': { runId: string; messageId: string };
  'run.failed': { runId: string; code: string; message: string };
};

export type EventEnvelope<T extends EventType = EventType> = {
  [K in T]: {
    schemaVersion: 1;
    eventId: string;
    conversationId: string;
    sequence: number;
    occurredAt: string;
    type: K;
    payload: EventPayloads[K];
  };
}[T];

export type SubmitMessageRequest = {
  conversationId: string;
  clientRequestId: string;
  text: string;
};

export const DEFAULT_CONVERSATION_ID = 'default';

export interface EventStore {
  append(event: EventEnvelope): Promise<void>;
  readAll(conversationId: string): Promise<EventEnvelope[]>;
}

export interface AgentProvider {
  streamReply(
    input: { text: string },
    signal: AbortSignal,
    onDelta: (text: string) => Promise<void>,
  ): Promise<void>;
}

export function createDeterministicProvider(options?: {
  chunkDelayMs?: number;
  failOnPrompt?: (text: string) => boolean;
}): AgentProvider;

export interface AgentBridge {
  readConversation(conversationId: string): Promise<EventEnvelope[]>;
  submitMessage(request: SubmitMessageRequest): Promise<void>;
  onEvent(listener: (event: EventEnvelope) => void): () => void;
}
```

The first slice supports exactly one conversation with ID `default`. At main-process startup, the coordinator reads its journal, initializes the conversation if empty, restores the next sequence number, and reconstructs seen `clientRequestId` values before accepting submissions.

Event payloads:

- `conversation.created`: `{ title: string }`
- `message.user.created`: `{ messageId: string, clientRequestId: string, text: string }`
- `run.started`: `{ runId: string, sourceMessageId: string }`
- `message.agent.created`: `{ messageId: string, runId: string }`
- `message.agent.delta`: `{ messageId: string, runId: string, text: string }`
- `run.completed`: `{ runId: string, messageId: string }`
- `run.failed`: `{ runId: string, code: string, message: string }`

The event factory assigns a strictly increasing sequence per conversation and a unique `eventId`. The coordinator owns event construction. `EventStore.append` resolves after the OS-level append write completes; the coordinator emits to renderer subscribers only after that promise resolves. This slice does not promise survival of sudden power loss because it does not force an fsync after every event.

## Task 1: Scaffold and Verify the Desktop Shell

**Files:**
- Create: `.nvmrc`, `.gitignore`, `README.md`, `package.json`, `package-lock.json`, `forge.config.ts`, TypeScript/Webpack configs, Forge-generated app entry points
- Test: `tests/smoke/renderer-smoke.test.ts`

**Interfaces:**
- Produces: npm scripts `start`, `typecheck`, `lint`, `test`, `package`, and `make`
- Produces: one development Electron window and one packaged Windows artifact

- [ ] **Step 1: Generate the Forge TypeScript + Webpack application in a scratch folder**

Run the official Forge initializer:

```powershell
npx create-electron-app@latest work/forge-seed --template=webpack-typescript
```

Review the generated app. Copy its package/config/source scaffold into the repository root, excluding `work/forge-seed/.git`, dependencies and build output. Do not replace the existing design document. If generated files include a `README.md`, merge the useful setup instructions rather than overwriting an existing user document.

Expected: `package.json`, lockfile, Forge config, TypeScript config, Webpack configs and Electron entry files exist.

- [ ] **Step 2: Set the project Node version and ignore generated/local files**

Add `.nvmrc` with `24.15.0`. Add ignore rules for `node_modules/`, `out/`, `.webpack/`, `work/`, coverage, logs, `.env*`, and local test data. Do not ignore `outputs/` or `docs/`.

- [ ] **Step 3: Add explicit package scripts and engine metadata**

Add scripts with these names: `start`, `typecheck`, `lint`, `test`, `package`, and `make`. Set `engines.node` to `>=24.15.0`. Keep generated template scripts that are used by Forge; map `package` to Forge's package command and `make` to Forge's make command. Set `typecheck` to `tsc --noEmit`, `lint` to ESLint on `src/` and `tests/`, and `test` to Vitest.

- [ ] **Step 4: Add React and the deterministic test/lint toolchain**

Install React 18 and React DOM 18 as runtime dependencies, plus matching React type packages, Vitest, a DOM test environment, React Testing Library, `@testing-library/jest-dom`, ESLint and the TypeScript ESLint parser/config as development dependencies. The Forge React + TypeScript guide documents a React 18/TypeScript 4.3/Webpack 5 example; use it as a compatibility reference, but retain the scaffold's supported TypeScript version unless validation identifies a conflict. Add a flat ESLint config scoped to `src/` and `tests/`.

Add a renderer entry that mounts a single heading, `Agent Workbench`, and a smoke test that verifies the root component renders without launching Electron or a model.

- [ ] **Step 5: Enable the renderer security baseline**

In the Forge BrowserWindow configuration, explicitly set `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and leave `webSecurity` enabled. Add a restrictive CSP to the local HTML. Do not add remote navigation or a generic IPC bridge.

- [ ] **Step 6: Run scaffold verification**

Run:

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npm start
```

Expected: clean install, zero type/lint/test failures, and one visible Electron window. Close the window normally after confirming it launches. Add `tests/unit/contracts.test.ts`, `tests/unit/event-store.test.ts`, `tests/unit/run-coordinator.test.ts`, `tests/integration/ipc.test.ts`, and `src/renderer/state/conversation-reducer.test.ts` to the Vitest include patterns as those files are created.

- [ ] **Step 7: Document and commit the runnable shell**

Document the exact install, run, test, package and make commands in `README.md`. Include that the current shell is not an Agent yet. Commit only scaffold and documentation files with message `chore: scaffold secure electron shell`.

**Stage 0 acceptance:** Another clean checkout can use the pinned Node version and `npm ci` to typecheck, test, and launch the app. The window renderer has no Node integration and no remote content.

## Task 2: Define and Test Event Contracts and Local Journal

**Files:**
- Create: `src/shared/contracts.ts`
- Create: `src/main/events/event-store.ts`
- Test: `tests/unit/contracts.test.ts`
- Test: `tests/unit/event-store.test.ts`

**Interfaces:**
- Consumes: project test runner from Task 1
- Produces: `EventEnvelope`, `SubmitMessageRequest`, `validateSubmitMessageRequest`, `validateEventEnvelope`
- Produces: `JsonlEventStore(filePath)` implementing `append(event)` and `readAll(conversationId)`

- [ ] **Step 1: Write contract tests for valid and invalid submit commands**

Test these behaviors:

```ts
expect(validateSubmitMessageRequest({
  conversationId: 'conv-1',
  clientRequestId: 'req-1',
  text: 'Explain this project',
})).toEqual({ ok: true });

expect(validateSubmitMessageRequest({
  conversationId: 'conv-1',
  clientRequestId: '',
  text: '   ',
})).toMatchObject({ ok: false });
```

Also test an over-limit prompt and wrong field types. Use a documented fixed input limit of 20,000 UTF-16 code units in this first slice.

- [ ] **Step 2: Run contract tests and confirm the expected RED result**

Run: `npx vitest run tests/unit/contracts.test.ts`

Expected: FAIL because the validators do not yet exist. A TypeScript import error is not a valid RED result; fix test setup until assertions execute and fail for the missing behavior.

- [ ] **Step 3: Implement contract types and runtime validators**

Implement the shared types in the interface section and validators that return discriminated results:

```ts
type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };
```

Do not add a general schema framework for two small contracts. Keep validation in `shared/contracts.ts` until a real need for a schema library appears.

- [ ] **Step 4: Run contract tests and confirm GREEN**

Run: `npx vitest run tests/unit/contracts.test.ts`

Expected: all valid, blank, oversized and wrong-type cases pass.

- [ ] **Step 5: Write journal tests before implementation**

Test append/read round-trip, filtering by conversation, stable sequence order, two concurrent appends remaining whole records, and corruption policy. A final incomplete JSON object is ignored; malformed JSON in an earlier complete line rejects with a descriptive error.

- [ ] **Step 6: Run journal tests and confirm RED**

Run: `npx vitest run tests/unit/event-store.test.ts`

Expected: failures identify missing journal behavior rather than fixture or filesystem setup errors.

- [ ] **Step 7: Implement serialized append and strict replay**

Implement `JsonlEventStore` with Node filesystem APIs in the main process only. Serialize appends through a per-instance promise queue. Append one JSON object plus `\n`. During replay, validate each complete record and filter by conversation after validation. Ignore only an invalid final non-newline-terminated fragment; reject malformed newline-terminated records and invalid event envelopes.

- [ ] **Step 8: Run focused and full checks**

Run `npx vitest run tests/unit/contracts.test.ts tests/unit/event-store.test.ts`, then `npm run typecheck` and `npm test`.

Expected: all focused and existing tests pass; no secret or path outside the supplied storage file is introduced by the journal.

- [ ] **Step 9: Commit the contract and journal**

Commit the shared contracts and journal implementation/tests with message `feat: add versioned local event journal`.

## Task 3: Implement the Deterministic Agent Run and Secure IPC

**Files:**
- Create: `src/main/agent/provider.ts`
- Create: `src/main/agent/run-coordinator.ts`
- Create: `src/main/ipc/register-handlers.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Create: `src/renderer/agent-api.d.ts`
- Test: `tests/unit/run-coordinator.test.ts`
- Test: `tests/integration/ipc.test.ts`

**Interfaces:**
- Consumes: contracts and `EventStore` from Task 2
- Produces: deterministic `AgentProvider`
- Produces: `RunCoordinator.initialize()`, `RunCoordinator.submit(request)` and `RunCoordinator.readConversation(conversationId)`
- Produces: allowlisted `window.agent` implementation of `AgentBridge`

- [ ] **Step 1: Write coordinator tests for event order and deterministic streaming**

Use a temporary real journal and the actual local provider. Submit one prompt and assert the persisted event sequence is `message.user.created`, `run.started`, `message.agent.created`, one or more `message.agent.delta`, then `run.completed`. Assert the concatenated delta equals the provider's deterministic response.

- [ ] **Step 2: Run coordinator tests and confirm RED**

Run: `npx vitest run tests/unit/run-coordinator.test.ts`

Expected: the behavior assertions fail because the coordinator/provider are not implemented. Fix test setup errors rather than treating them as the expected failure.

- [ ] **Step 3: Implement the deterministic provider**

The provider accepts the prompt and `AbortSignal`, emits a documented fixed response in multiple chunks with a small injectable delay, and never uses network, filesystem or process APIs. An injected test mode can throw a deterministic provider error; do not add hidden environment-variable behavior.

- [ ] **Step 4: Implement run coordination, ordering and idempotency**

The coordinator validates requests, rejects blank/oversized text, and accepts only `DEFAULT_CONVERSATION_ID`. On `initialize()`, read the journal, append `conversation.created` only when empty, restore the next sequence number, and reconstruct idempotency keys from persisted user-message events. Reuse of the same key returns without creating a second run. Construct sequence numbers in one main-process owner. For every event, `await store.append(event)` before notifying subscribers.

- [ ] **Step 5: Run coordinator tests and confirm GREEN**

Run: `npx vitest run tests/unit/run-coordinator.test.ts`

Expected: correct event order, deterministic reconstructed output, provider error terminal event, and at-most-one run for a duplicate request.

- [ ] **Step 6: Write IPC boundary tests before registering handlers**

Test rejection of malformed commands, wrong sender frame/origin, blank input, oversized input and unknown command channel. Test that a valid submit reaches the coordinator and that subscribers receive persisted events in sequence.

- [ ] **Step 7: Run IPC tests and confirm RED**

Run: `npx vitest run tests/integration/ipc.test.ts`

Expected: behavior assertions fail because secure handlers and the bridge are missing. The test harness must model sender validation without bypassing the handler's actual validator.

- [ ] **Step 8: Implement IPC handlers and the narrow preload bridge**

Register only `agent:read-conversation`, `agent:submit-message`, and `agent:event`. Check that commands originate from the known main window and expected local renderer URL. Expose `readConversation`, `submitMessage`, and `onEvent`; wrap event listeners so the returned unsubscribe function removes exactly that listener. Do not expose `ipcRenderer`, `fs`, `process`, arbitrary channels or arbitrary file paths.

- [ ] **Step 9: Run unit, integration and static checks**

Run `npx vitest run tests/unit/run-coordinator.test.ts tests/integration/ipc.test.ts`, `npm run typecheck`, and `npm run lint`.

Expected: all tests pass. A renderer-origin mismatch fails closed and emits no event.

- [ ] **Step 10: Commit the runtime boundary**

Commit the provider, coordinator, IPC and tests with message `feat: stream deterministic agent runs over validated ipc`.

## Task 4: Build the Event-Driven Conversation UI

**Files:**
- Create: `src/renderer/state/conversation-reducer.ts`
- Create: `src/renderer/components/App.tsx`
- Create: `src/renderer/components/Composer.tsx`
- Create: `src/renderer/styles.css`
- Modify: `src/renderer/main.tsx`
- Modify: `src/renderer/agent-api.d.ts`
- Test: `src/renderer/state/conversation-reducer.test.ts`

**Interfaces:**
- Consumes: `EventEnvelope` and `AgentBridge`
- Produces: pure `conversationReducer(state, event)` and user-facing conversation, loading and failure states

- [ ] **Step 1: Write reducer tests before implementing the UI**

Test that user messages are added once, agent deltas append to the correct run/message, each accepted event appears once in the trace, event sequence duplicates do not duplicate text, completion clears the active run, and failure leaves the user message visible with an error state.

- [ ] **Step 2: Run reducer tests and confirm RED**

Run: `npx vitest run src/renderer/state/conversation-reducer.test.ts`

Expected: assertions fail because the reducer does not exist.

- [ ] **Step 3: Implement the pure reducer**

Reducer state includes `conversationId`, ordered messages, ordered `events` for the read-only trace, `activeRunId`, `lastSequence`, and a user-visible recoverable error. Ignore an already-applied sequence, reject an unexpected gap by setting a reload-required state, and never mutate the input state or events.

- [ ] **Step 4: Run reducer tests and confirm GREEN**

Run: `npx vitest run src/renderer/state/conversation-reducer.test.ts`

Expected: order, deduplication, delta, completion and failure assertions pass.

- [ ] **Step 5: Implement the conversation, event trace and composer**

Render an unframed conversation work area, distinct user/agent messages, visible active-run state, bounded scroll area, and a compact composer. Include a read-only event trace listing sequence, local timestamp and event type in order; it must not expose filesystem paths, credentials or raw environment values. Disable submit while a run is active or text is blank. Enter submits; Shift+Enter inserts a newline. Show run failures inline without removing prior messages. No setup splash or marketing page.

- [ ] **Step 6: Connect preload events and restore on startup**

Subscribe before requesting persisted history. Buffer live events while history loads, merge by sequence and pass the ordered set through the reducer so events arriving during startup are not lost. Dispose the subscription when the React component unmounts. Generate a fresh `clientRequestId` per user submission and retain it while that request is pending.

- [ ] **Step 7: Run renderer, integration and manual checks**

Run `npm test`, `npm run typecheck`, and `npm run lint`. Run `npm start`, submit a prompt, verify visible incremental text and a subsequent successful prompt after a forced provider failure.

Expected: no duplicate or missing text; input and error states remain usable and visually do not overlap at a 1280x800 window.

- [ ] **Step 8: Commit the user-visible conversation**

Commit the reducer, UI and tests with message `feat: add streamed conversation workbench`.

## Task 5: Verify Restart Persistence and Windows Package

**Files:**
- Create: `tests/e2e/conversation.e2e.ts`
- Modify: `package.json`, `README.md`, Forge maker config, main-process test-only user-data initialization
- Modify: `src/main/index.ts` only if E2E exposes a lifecycle defect

**Interfaces:**
- Consumes: packaged app, event journal and `AgentBridge`
- Produces: repeatable E2E command and a Windows package artifact

- [ ] **Step 1: Add a test-only isolated user-data directory**

Add an E2E-only launch argument that supplies a temporary user-data directory before `app.whenReady()`. Accept this override only when the packaged executable is launched with an explicit test flag; normal launch must always use Electron's default `userData` path. The E2E creates a fresh temporary directory and never points at the user's real application data.

- [ ] **Step 2: Package the app before writing the restart E2E**

Run `npm run package` and locate the unpacked Forge output directory and executable. Add a small resolver in the E2E setup that derives this path from the Forge app name and target architecture; do not hard-code a developer-specific absolute path.

- [ ] **Step 3: Write the restart E2E test**

Use Playwright's Electron automation API (`_electron.launch`) against the packaged executable. Launch with the E2E-only user-data argument, submit a fixed prompt, wait for `run.completed`, assert the rendered answer and event trace, and verify `window.require` and `window.process` are unavailable in the renderer. Close the app, relaunch with the same temporary user-data directory, and assert both user and assistant messages and event order are restored.

- [ ] **Step 4: Run E2E once and verify the harness reaches the packaged application**

Run: `npm run package`, then `npm run test:e2e`.

Expected on the first run: a failing assertion is acceptable; the harness must launch the Forge packaged executable and not only a browser-rendered component. If the packaged-app harness exposes a platform limitation, keep unit/integration and packaged-app smoke evidence distinct; do not silently substitute a mocked renderer test for the restart E2E.

- [ ] **Step 5: Implement any minimum lifecycle fix exposed by RED**

Make only the change needed for deterministic startup restore or clean shutdown. Add a focused regression assertion before changing production code.

- [ ] **Step 6: Run the E2E test and confirm GREEN**

Run: `npm run package`, then `npm run test:e2e`.

Expected: the test proves launch of the packaged app, stream completion, shutdown, relaunch and exact transcript restoration from the same isolated local journal.

- [ ] **Step 7: Build the Windows installer artifact and run the complete test matrix**

Run:

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npm run package
npm run test:e2e
npm run make
```

Expected: all commands exit successfully and Forge creates an unpacked Windows app plus a Windows installer artifact. Record actual artifact paths and build output; do not claim installation success unless the produced installer is launched and verified.

- [ ] **Step 8: Update the README with evidence and commit**

Document the exact package path, tests that ran, and known limitation that this is deterministic Mock behavior. Commit with message `test: verify persisted conversation in packaged electron app`.

## End-to-End Acceptance Checklist

- [ ] A clean checkout installs with `npm ci` on Node.js `24.15.0`.
- [ ] `npm run typecheck`, `npm run lint`, and `npm test` pass.
- [ ] The desktop window launches with the secure renderer settings.
- [ ] A prompt receives visible streamed Mock output without network access.
- [ ] A read-only timestamped event trace is visible in the UI.
- [ ] Events are persisted before the UI receives them.
- [ ] A duplicate request id does not create a second run.
- [ ] A simulated failure is persisted and the UI remains usable.
- [ ] A completed conversation restores exactly after closing and relaunching.
- [ ] The real Electron E2E passes against an isolated temporary user-data directory.
- [ ] A Windows package is produced and its artifact is recorded.
- [ ] User changes in `outputs/agent-workbench-design.md` are preserved.

## Learning Checkpoints

- Before Task 2: explain why TypeScript types do not validate IPC input at runtime.
- After Task 2: explain why append is serialized and why malformed middle records differ from a partial final record.
- After Task 3: trace one prompt from renderer to main process and explain why persistence occurs before broadcast.
- After Task 4: explain why UI state is derived from events rather than updated through several unrelated callbacks.
- After Task 5: demonstrate the restart test and state what it does not prove about crash recovery or rollback.

## References Checked 2026-10-10

- Approved design and roadmap: `outputs/agent-workbench-design.md`.
- Electron security checklist: https://www.electronjs.org/docs/latest/tutorial/security
- Electron Forge Webpack plugin: https://www.electronforge.io/config/plugins/webpack
- Electron Forge React integration guide: https://www.electronforge.io/guides/framework-integration/react
- Electron Forge React + TypeScript guide: https://www.electronforge.io/guides/framework-integration/react-with-typescript
- Playwright Electron API: https://playwright.dev/docs/api/class-electron
- The Forge React + TypeScript guide states that its example was tested with React 18, TypeScript 4.3, and Webpack 5. Verify exact package compatibility when implementing; lock resolved versions rather than assuming a documentation page is a release pin.
- Playwright's official Electron API documents `_electron.launch`; use it only for E2E and retain deterministic unit/integration coverage independently.
- This initial plan does not install or import Pi packages. Pi integration is planned for Stage 2/3 only after this shell's Electron/Node runtime compatibility is verified against the exact Pi package release.
