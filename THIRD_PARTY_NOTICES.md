# Third-Party Notices

Stage 0-1, checked against installed package metadata on 2026-10-10.

| Dependency / reference | Version | License | Reuse boundary |
| --- | --- | --- | --- |
| Electron | 44.7.0 | MIT, plus bundled third-party notices | Desktop runtime and renderer sandbox |
| Electron Forge official Webpack/TypeScript template and CLI | 8.0.1 | MIT | Generated build configuration and packaging |
| React / React DOM | 18.3.1 | MIT | Renderer components |
| lucide-react | 1.54.0 | ISC | UI icons |
| electron-squirrel-startup | 1.0.1 | Apache-2.0 | Windows installer startup handling |
| Playwright test | 1.64.0 | Apache-2.0 | Development-only packaged Electron automation |

The lockfile records the complete dependency graph, including transitive
packages. This table is not an exhaustive license audit or an SBOM.
Keep upstream license files and Electron's packaged license/Chromium notices
with redistributed binaries. Webpack retains extracted dependency license
comments in `index.js.LICENSE.txt`; do not remove it from the packaged ASAR.

The deterministic provider, coordinator, event contracts/journal, typed IPC
bridge, conversation reducer and focused regression tests are project code
developed with assistant/subagent help. They do not constitute a self-built
LLM or a reused production Agent kernel.

Pi (`badlogic/pi-mono`) and the supplied Agent textbook informed the approved
design. No Pi source or package is copied, imported or installed in Stage 1.
Future integration must separately verify its exact source revision, exported
APIs, package compatibility and licensing. Design reference is not API validation.
