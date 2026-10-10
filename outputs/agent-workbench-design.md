# Developer Knowledge and Task Agent Workbench

**Status:** Design proposal for review
**Date:** 2026-10-10
**Product:** Single-user, local-first Windows desktop application

## 1. Product Goal

Build a desktop workbench that helps a developer understand a code repository, research technical questions using local and external evidence, and make code changes only within explicitly authorized boundaries.

The project is also a learning and interview artifact. Each major capability must have an implementation path, test evidence, and questions the developer can explain. The project will not claim user adoption, commercial impact, production use, or performance improvements without measured evidence.

## 2. Constraints and Non-Goals

### Constraints

- Prefer a modular monolith; do not add distributed infrastructure without measured need.
- Keep the UI, trusted desktop runtime, model adapters, tool execution, and persistence behind explicit interfaces.
- Default to workspace-scoped file access and least privilege.
- Treat model output, retrieved documents, MCP responses, and command output as untrusted input.
- Approval applies to a displayed, canonical operation and its parameters. Any change to the operation invalidates that approval.
- Approval prompts are not a sandbox. Stronger isolation requires an OS or container boundary, with its limitations documented.
- Preserve existing user changes. Recovery must inspect tool state and must not blindly replay side effects.
- Use a fixed regression set, separated into a development set and a held-out set. Record model identifier, configuration, prompt/eval version, latency, token/cost data when available, and outcome.
- Label Mock, real-model, and end-to-end evidence separately.

### Non-Goals

- Multi-tenancy, billing, hosted collaboration, or a plugin marketplace.
- General-purpose personal assistant behavior.
- Multi-agent orchestration in the initial product path.
- Claims of guaranteed rollback or complete containment of arbitrary code execution.

## 3. Recommended Architecture

Use Electron + React + TypeScript as a modular desktop application. Electron main owns privileged operations and persistence. The renderer is an untrusted presentation process with Node integration disabled, context isolation enabled, and a narrowly allowlisted preload API. The preload API exposes application commands and event subscriptions, not general filesystem or shell access.

The initial runtime uses a deterministic local provider. Once the vertical slice is tested, integrate Pi's model and agent libraries through an application-owned adapter. The application owns policy decisions, task lifecycle, event/audit history, retrieval, approval UX, and persistence. It will not fork or maintain a second general-purpose agent loop unless integration evidence shows a concrete unmet requirement.

Proposed module boundaries:

| Module | Responsibility |
|---|---|
| `shared/contracts` | Versioned command, event, and tool schemas shared across process boundaries |
| `desktop/main` | Window lifecycle, validated IPC, task coordination, policy decisions |
| `desktop/preload` | Small typed bridge for allowed UI commands and event subscriptions |
| `runtime/model-adapters` | Model provider configuration and streaming adapter |
| `runtime/agent` | Pi-backed Agent adapter, run lifecycle, budgets and cancellation |
| `runtime/tools` | Tool registry, parameter validation, approval binding and scoped executors |
| `knowledge` | File discovery, incremental indexing, retrieval, citations and context budgeting |
| `storage` | Versioned local persistence, event history, settings, memory and migrations |
| `renderer` | Workspace/session/task views, approval, tool trace, diff and configuration UI |
| `evals` | Fixed task sets, runner, outcome rubric and reproducible reports |

This is a logical boundary proposal, not a requirement to create a package for every row. Implementation may group modules until there is a concrete reason to split them.

## 4. First Vertical Slice

### Goal

Prove the complete local desktop path with one conversation:

1. Launch the desktop app.
2. Submit a prompt.
3. Receive a deterministic response as streamed chunks.
4. Persist the conversation locally.
5. Close and reopen the app and restore the conversation.
6. Inspect a timestamped event trace and understand which process owns each step.

This slice tests the application architecture without requiring API credentials or presenting Mock behavior as real-model behavior.

### Non-Goals

- Real model calls, tools, filesystem writes, shell commands, MCP, browser access, multiple workspaces, multi-agent behavior, or vector search.
- Production-grade crash recovery or automatic rollback.
- A completed commercial-grade design system.

### Initial Event Contract

All events are versioned and scoped to a conversation. Events are persisted before being broadcast to the renderer.

```ts
type EventEnvelope<TType extends string, TPayload> = {
  schemaVersion: 1;
  eventId: string;
  conversationId: string;
  sequence: number;
  occurredAt: string;
  type: TType;
  payload: TPayload;
};
```

Initial event types:

- `conversation.created`
- `message.user.created`
- `run.started`
- `message.agent.created`
- `message.agent.delta`
- `run.completed`
- `run.failed`

Sequence numbers increase strictly per conversation. Each user submission carries a client-generated idempotency key. Replay concatenates assistant delta events. Event data must not contain credentials.

### Data Flow

1. Renderer sends a typed `message.submit` command through the preload bridge.
2. Main validates the command and idempotency key.
3. Main appends the user message and run-started events to local storage.
4. The deterministic provider produces chunks through the same provider interface planned for a real model adapter.
5. Main persists each chunk event before forwarding it to the renderer.
6. Main persists a terminal completion or failure event.
7. Renderer state is derived from the event stream; startup replays persisted events.

### Acceptance Scenarios

- Fresh launch shows an empty conversation and a usable composer.
- Submitting a prompt immediately shows the user message and then streamed assistant text.
- Repeated submission with the same idempotency key creates at most one run.
- Closing and reopening restores the transcript in the same order.
- A deterministic provider failure leaves the user message visible, records a failure, and allows another submission.
- The renderer cannot directly access Node.js or filesystem APIs.

## 5. Storage and Reliability Direction

For the first slice, use an append-only JSONL journal under Electron's `userData` location, with a versioned event envelope and serialized writes. Replay should tolerate a partial final line without silently accepting malformed earlier records. The persistence adapter will isolate storage format so SQLite can be evaluated when indexing/query needs justify it.

Before enabling side-effecting tools, the runtime must add:

- explicit task and tool-call states, including `approval_pending`, `running`, `succeeded`, `failed`, `cancelled`, and `unknown_after_interruption`;
- cancellation and timeouts propagated to supported operations;
- finite retry rules limited to operations known to be safe to retry;
- task, token, cost, and time budgets where providers expose the data;
- approval records bound to tool name, canonical parameters, workspace, and policy version;
- checkpoint/recovery review that checks persisted tool status before offering continuation;
- diffs and user-change preservation before writes.

An interrupted side effect may have completed even if the application did not record completion. Recovery must surface uncertainty and require inspection; it must not automatically repeat the call.

## 6. Security and Data Handling

- Renderer content and all external/model/tool outputs are untrusted.
- Main process validates every IPC command and every tool argument independently of UI validation.
- The preload bridge exposes named operations only; it does not expose raw `ipcRenderer`, Node APIs, or arbitrary file paths.
- Workspace paths are canonicalized and checked against authorized roots at execution time. Symlink and junction behavior must be tested on Windows.
- API credentials are never written to event logs, prompts, crash reports, or exported diagnostics. Provider requests disclose prompts and selected context to the configured provider; the setup UI must state this before a real request is made.
- Command execution is disabled until an explicit policy, approval, timeout, cancellation, output limit, and execution boundary are implemented and tested.
- MCP server output, Skills content, repository content, and retrieved web content do not receive authority merely because they contain instructions.
- Logs are local by default. Export is user-initiated and redacts known secret fields.

These controls reduce accidental exposure and enforce application policy. Electron process separation and confirmation dialogs do not constitute an OS sandbox against a compromised application or arbitrary native code.

## 7. Staged Roadmap

### Stage 0: Project foundation

- **Goal:** Create a reproducible TypeScript/Electron development setup and explain how to run it.
- **Non-goals:** Agent behavior, model credentials, tools.
- **Work:** Pin compatible Node/Electron/tool versions; establish lint, typecheck, test, packaging skeleton, and architecture notes.
- **Tests:** Clean install, typecheck, lint, unit-test smoke, launch packaged development window.
- **Acceptance:** A beginner can follow the README to launch the blank desktop shell.
- **Risks:** Electron's embedded Node may not satisfy Pi packages' engine floor; verify compatibility before selecting the runtime integration mode.

### Stage 1: Persisted streamed conversation

- **Goal:** Deliver the first vertical slice above.
- **Non-goals:** Real model, multiple sessions, tools.
- **Work:** Shared contracts, secure IPC bridge, Mock provider, event journal, renderer reducer and conversation UI.
- **Tests:** Contract, storage replay, duplicate request, provider success/failure, IPC security smoke, packaged restart E2E.
- **Acceptance:** All first-slice scenarios pass without network access.
- **Risks:** Event ordering, partial writes, and process-specific behavior in packaged builds.

### Stage 2: Real model adapter

- **Goal:** Add an explicitly configured provider with streaming, cancellation and usage/error capture.
- **Non-goals:** Tool execution and autonomous code changes.
- **Work:** Pi `pi-ai` adapter; secure credential storage decision; provider configuration and disclosure UI; redacted diagnostics.
- **Tests:** Mock adapter contract suite plus opt-in live provider tests, clearly labeled and never required for deterministic CI.
- **Acceptance:** A user can configure a provider, understand data egress, stream a response, cancel it, and inspect usage/error metadata.
- **Risks:** API compatibility, rate limits, changing model behavior, Electron/Node engine compatibility, and secret leakage.

### Stage 3: Agent loop and read-only tools

- **Goal:** Add Pi `pi-agent-core` behind an application adapter and a small read-only tool set.
- **Non-goals:** Arbitrary shell, writes, multi-agent orchestration.
- **Work:** Tool schema validation, event tracing, bounded loops, run cancellation and budget checks.
- **Tests:** Mock tool-call tests, malformed argument tests, loop/budget exhaustion, live-model opt-in suite.
- **Acceptance:** The agent can inspect only authorized workspace files and provide citations that resolve to inspected content.
- **Risks:** Tool-call arguments are untrusted; the Pi loop is not itself a permission sandbox.

### Stage 4: Evidence-based repository knowledge

- **Goal:** Support incremental code/document indexing with source citations.
- **Non-goals:** Broad web crawler, autonomous memory writes, vector database by default.
- **Work:** Ignore rules, file fingerprinting, lexical retrieval, context budget selection, citation records, index management UI.
- **Tests:** Fixed retrieval development set and held-out set; stale-file, excluded-file, missing-source and budget tests.
- **Acceptance:** A user can inspect each cited source location and reproduce retrieval results for a recorded index version.
- **Risks:** Large/binary files, generated content, stale indexes, and misleading relevance.

### Stage 5: Approved code changes and verification

- **Goal:** Propose a diff, request parameter-bound approval, apply scoped changes, and run bounded validation.
- **Non-goals:** Guaranteed rollback, silent writes, unrestricted process execution.
- **Work:** Workspace path enforcement, snapshots/diffs, approval records, command policy, cancellation, output caps, uncertain-state recovery.
- **Tests:** Path traversal, symlink/junction, changed-parameter approval, user edits before apply, timeout, cancellation, process interruption and partial effects.
- **Acceptance:** No write or command proceeds without a valid approval for the exact operation; resulting diff and validation evidence are inspectable.
- **Risks:** TOCTOU/path races, subprocess descendants, files modified outside the app, and ambiguous interruption outcomes.

### Stage 6: MCP, Skills and managed memory

- **Goal:** Add opt-in interoperability and user-visible memory controls.
- **Non-goals:** Marketplace or implicit trust of third-party servers and skills.
- **Work:** Explicit server/skill enablement, schemas, provenance, secret scope, memory review/edit/delete.
- **Tests:** Malicious instructions in tool output, malformed schemas, unavailable server, secret redaction and memory deletion.
- **Acceptance:** The user can see what is enabled, what data it can access, and remove stored memories.
- **Risks:** Third-party supply chain, prompt injection and broad credential access.

### Stage 7: Evaluation and optimization

- **Goal:** Measure reliability changes on a versioned task suite.
- **Non-goals:** Claims based on cherry-picked examples.
- **Work:** Separate development and held-out tasks; mock, real-model and end-to-end lanes; cost/time/outcome report; failure taxonomy.
- **Tests:** Normal task, retrieval failure, rate limit, timeout, cancellation, out-of-scope access, and interrupted execution.
- **Acceptance:** Every optimization report identifies commit, model/version, configuration, dataset split and raw outcome records.
- **Risks:** Model drift, evaluator bias, small samples and leakage from held-out cases.

### Stage 8: Windows delivery

- **Goal:** Deliver an installable Windows client with first-run setup, logs, backup and migration validation.
- **Non-goals:** Auto-update without a signed release and tested migration policy.
- **Work:** Installer, app identity, first-run provider disclosure, versioned migrations, export/redaction, backup/restore.
- **Tests:** Clean install, upgrade from prior schema, interrupted migration, backup restore, uninstall data policy and packaged E2E.
- **Acceptance:** A clean Windows environment can install, configure, use, export diagnostics, back up, and restore the app.
- **Risks:** Signing, Windows path behavior, antivirus interactions, packaging/runtime differences.

### Independent experiment: multi-agent orchestration

Only begin after Stages 3-7 establish a reliable single-agent baseline. Compare the same held-out tasks against single-agent runs. Record success rate, cost, elapsed time, failure modes, and variance. Keep the experiment only if it demonstrates a useful trade-off; dialogue screenshots are not evidence.

## 8. Knowledge-to-Evidence-to-Interview Map

| Knowledge point | Product requirement | Module | Test evidence | Interview question |
|---|---|---|---|---|
| Process boundaries and IPC | Keep privileged APIs out of renderer | Electron preload/contracts | Renderer API exposure smoke test | Why is context isolation not a complete sandbox? |
| Event-driven state | Trace and restore a run | Shared contracts, storage, reducer | Ordering, replay, duplicate-submit tests | Why persist before broadcasting? |
| Model streaming | Show incremental output and cancellation | Model adapter | Adapter contract and cancellation tests | How do you normalize provider differences? |
| Agent loop | Use tools under finite limits | Agent adapter/runtime | Loop and budget exhaustion tests | How do you prevent unbounded tool loops? |
| Structured tool calls | Reject malformed or changed parameters | Tool registry/policy gate | Schema and approval-binding tests | Why validate tool arguments after model output? |
| Retrieval and citations | Ground answers in inspectable evidence | Knowledge index | Held-out retrieval set and citation checks | How do you measure retrieval quality? |
| Context budgeting | Fit evidence into a bounded request | Context builder | Token-budget boundary tests | What gets omitted when context is too large? |
| Reliability and recovery | Do not repeat uncertain side effects | Task store/recovery flow | Interrupted execution tests | How do you handle “tool may have completed”? |
| Evaluation design | Prove a change improves outcomes | Eval runner | Versioned dev/held-out reports | How do you avoid tuning against the test set? |
| Desktop delivery | Install, migrate and support locally | Packaging/storage | Install/upgrade/restore E2E | How did you validate schema migration? |

## 9. Learning and Contribution Contract

The assistant may implement scaffolding and routine integration, but each stage includes a learner-owned exercise:

- Stage 0: run the scripts, explain each process, and make one small typed UI change.
- Stage 1: independently extend the event reducer and diagnose a replay test failure.
- Stage 2: explain credential storage and trace where a prompt leaves the machine.
- Stage 3: add a read-only tool test and explain why validation belongs in the trusted runtime.
- Stage 4: investigate one retrieval failure and record a short failure analysis.
- Stage 5: reproduce an approval-binding or path-boundary test and explain its security property.
- Stage 7: run the evaluation command, interpret the held-out results, and state limitations.
- Stage 8: perform a clean install/backup/restore rehearsal and document the result.

The final resume bullets must be derived from repository history, test reports, and measured evaluation data. Reused Pi capability must be described as integration/adaptation, not as a self-built Agent kernel.

## 10. Reference and Version Notes

Checked on 2026-10-10:

- The reference URL `https://github.com/badlogic/pi-mono` redirects to `https://github.com/earendil-works/pi`.
- Current source package names are `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`. Current package documentation describes model/provider streaming in `pi-ai`, and the stateful Agent loop, events, and tool hooks in `pi-agent-core`.
- The current package manifests inspected for this proposal declare MIT and Node.js `>=22.19.0`. Pin and re-check the exact package release and transitive licenses before shipping; a moving `main` branch is not a dependency pin.
- Pi's repository documents that the Agent libraries do not provide a complete filesystem/process/network permission sandbox. Host-side policy, least privilege and, where needed, an OS/container isolation boundary remain application/deployment responsibilities.
- The教材 home page is used as a conceptual syllabus, not a source of API contracts. Its displayed chapter total is inconsistent between the page title and progress indicator; verify individual concepts against primary docs before implementation.
- Electron's official security guidance is the source of truth for Electron security settings. Settings reduce attack surface but do not replace application authorization or OS isolation.

Primary references:

- Pi repository: https://github.com/earendil-works/pi
- Pi AI package docs: https://github.com/earendil-works/pi/tree/main/packages/ai
- Pi Agent package docs: https://github.com/earendil-works/pi/tree/main/packages/agent
- Pi AI manifest: https://github.com/earendil-works/pi/blob/main/packages/ai/package.json
- Pi Agent manifest: https://github.com/earendil-works/pi/blob/main/packages/agent/package.json
- Pi containerization notes: https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs
- Electron security guide: https://www.electronjs.org/docs/latest/tutorial/security
- Learning reference: https://ai-agent-guide.xiaofuge.cn/
