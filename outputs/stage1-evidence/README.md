# Stage 1 Evidence

Recorded by the assistant/controller and development subagents on 2026-10-10.
Application source identity: `9b79c8dffe7664b83901a6d93a91b4fb72cf75a3`.
Documentation/evidence is committed separately. No learner exercise is certified.
Copied text logs are UTF-8 with trailing whitespace normalized; diagnostic
content, result counts and command output are otherwise retained.

- `vitest-final.txt` and `vitest-final.json`: separate passing runs, 217 tests.
- `typecheck-final.txt`, `lint-final.txt`: both exited 0.
- `make-final.txt`: final package and Windows makers exited 0.
- `e2e-final.txt`: three actual packaged Electron cases passed in 8.8 seconds.
- `special-path-final.txt`: additional real packaged path probe passed.
- `conversation-*.png`: final package screenshots; content sizes are 1280x800
  and 600x480 CSS pixels. Host scaling produces larger bitmap dimensions.
- `audit-development.json`: 9 findings, audit command exited 1 as expected.
- `audit-production.json`: production dependency audit, 0 findings, exit 0.
- `final-review.md`: original review and its three then-open findings.
- `final-fix-report.md`: correction scope, meaningful RED/GREEN and mutation test.
- `final-rereview.md`: supersedes the original open findings; scoped approval.
- `journal-fix-review.md`: independent corruption-parser correction review.

The PowerShell-captured logs can contain `NativeCommandError` formatting for
stderr warnings. Exit codes and final assertions, not that formatting alone,
determine whether a command failed. Make emitted an upstream fs.rmdir deprecation
warning; Playwright emitted terminal color-environment warnings.

To repeat the special-path probe after `npm ci` and `npm run package`, run
`node outputs/stage1-evidence/verify-special-path.cjs` from the repository root.
It copies the full package to a fresh ignored `work/verification` directory,
uses an isolated profile, closes the app and preserves the probe files.
It is an additional scripted probe, not a fourth Playwright-suite test.

`npm ci` and earlier scaffold launch succeeded in controller tool output, but
their full logs were not retained here. Installer execution, fresh-clone
installation, real models, full-process network isolation and performance
benchmarks were not performed.
