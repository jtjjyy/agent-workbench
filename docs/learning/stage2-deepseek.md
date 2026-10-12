# Stage 2 Learning And Evidence Map

Status: source implementation only, no tests or validation executed at user request.
No success rate, latency, billing or compatibility claims. All evidence below is pending.

| Knowledge | Product requirement | Implementation | Pending test evidence | Interview question / personal exercise |
| --- | --- | --- | --- | --- |
| Model abstraction | Mock and DeepSeek without two loops | shared/contracts.ts, main/agent/deepseek-provider.ts | Mock contract, opt-in live stream | Explain the boundary between application lifecycle and Pi model transport; add another Mock reply mode yourself |
| Real published SDK contracts | Avoid imagined interfaces | Pi 1.1.0 api/openai-completions.stream, utils/transcript.normalizeContext | ESM packaged launch | Find the installed type of text_delta and trace it through persistence to React |
| Secret lifecycle | Keys outside repository and journal | main/settings/model-settings-store.ts, model settings IPC | Encryption round trip, invalid/corrupt settings, key removal | Explain DPAPI's same-user limitation; diagnose unavailable encryption without logging the key |
| Data egress and untrusted text | Explicit external-model consent | shared/model-settings.ts, ModelSettingsDialog.tsx, fixed endpoint fetch | Sender forgery, false consent, forbidden URL/redirect | Draw exactly what leaves the machine; show why a model answer cannot invoke a tool |
| Stream lifecycle | Safe cancel and bounded request | main/agent/run-coordinator.ts, provider abort signals | Cancel, late delta, timeout, journal failure, interruption | Explain why cancellation is bound to run ID; design a timeout regression case |
| Context selection | Bounded successful exchanges only | RunCoordinator.readContext | Recent pairs, oversized pair, failed/Mock/truncated exclusions | Explain why UTF-16 length is not token count and why this is not context compression |
| Honest observability | Usage when reported, sanitized errors | RunUsage, provider-errors.ts, optional completion metadata | Missing usage, real usage, 401/402/429/5xx | Explain why absent usage is not free usage; why raw SDK errors must not be persisted |
| Recovery and compatibility | Old journal replay, no request duplication | Optional schema-v1 metadata, unfinished runs marked failed | Old/new journal, restart, stale cancel ID | Explain why restarting must not automatically replay an interrupted paid request |

## Capability Classes

- Mainline: model transport, streaming, settings, bounded context, cancellation, safe error/usage metadata.
- Independent future experiments: real-provider fault matrix, context-budget tuning, reasoning-mode cost/quality comparison.
- Principle study: SSE, abort propagation, token accounting, OS secret storage, IPC authority, idempotency.

## Next Evidence Work (Deferred)

Keep deterministic Mock tests, real-model tests and packaged desktop E2E separate.
Record exact requested model ID, returned model if collected, provider date/configuration,
output limit, timeout and completed usage. Do not substitute Stage 1's historical
test results for Stage 2 evidence. Broader Agent tools, knowledge retrieval and
multi-agent collaboration are not implemented by this model integration.
