# Focused Journal Parser Review

Date: 2026-10-10.
Baseline: `ab005a8`.
Scope: current working-tree changes in `src/main/events/event-store.ts` and
`tests/unit/event-store.test.ts` only. Read-only code review; this report is the
only file written. No tests, packaging, production edits, or broader review.

## Verdict

**Clean: no concrete important bug found in the parser correction.**
No newly introduced data-loss path was identified by static inspection.
This is not an independent test-pass claim.

## Reviewed Behavior

- `src/main/events/event-store.ts:22`: EOF position is compared against the full
  text length, not a whitespace-trimmed length. An invalid trailing character
  cannot become an apparent EOF merely because trimming shortens the string.
- `src/main/events/event-store.ts:29`: the string scan rejects raw control
  characters, unsupported escapes, and nonhex characters in Unicode escapes,
  including whitespace. Escaped quotes and backslashes are consumed without
  accidentally toggling string state. The scan applies equally to keys and values.
- `src/main/events/event-store.ts:41`: a final backslash remains recoverable.
  A Unicode escape ending after zero through three valid hex digits also remains
  recoverable; an actually present invalid digit is rejected. Complete valid
  escape sequences do not consume the following quote or character.
- The new recovery predicate is a restriction of the old predicate: both the
  stricter EOF-position check and the added scan can reject previously accepted
  tails, but cannot newly authorize truncation. The successful-JSON path is
  unchanged, preserving valid final records without a terminating newline.
- `src/main/events/event-store.ts:152`: recovery remains restricted to a final
  non-newline-terminated fragment. Completed and middle malformed records still
  throw. Replay does not mutate bytes; append truncates only after successful
  journal classification and sequence validation, at the unchanged byte offset
  (`src/main/events/event-store.ts:89`).

## Coverage Assessment

- `tests/unit/event-store.test.ts:24` includes malformed partial Unicode escapes,
  raw tab/carriage-return/NUL, unsupported escapes, and escaped raw tab.
- Lines 144 and 151 require both replay and append rejection and exact original
  byte preservation. Line 158 repeats these assertions for completed and middle
  records, including a later recoverable tail.
- Line 168 checks every nonempty incomplete byte prefix of a valid event with
  escaped quotes/backslashes/control characters, multibyte UTF-8, numbers,
  literals, arrays, and an object. It checks nonmutating replay and exact journal
  contents after recovery append, preserving the preceding committed record.
- Existing tests at lines 206 and 324 retain coverage for complete final records
  without newline and rejection of an invalid append before any tail repair.

## Limits

The classifier still depends on the runtime's JSON.parse SyntaxError wording
and position format; this dependency predates the correction. The prefix test is
a useful runtime-specific recovery check, not a proof for every JSON grammar
combination or future V8 release. I did not run it, per the coordination request.

The controller reports packaged E2E passed 3/3 in 9.2 seconds with screenshots
inspected. That is controller evidence, not independent verification of this
parser change. No production bridge or whole-application review was undertaken.
