# Third-Party Notices

Stages 0-2, based on installed package metadata read on 2026-10-10. Stage 2 integration is unverified.

## 第三阶段复用补充（2026-10-10）

精确新增 `@earendil-works/pi-agent-core@1.1.0`（MIT）和直接 schema 依赖
`typebox@1.3.27`（MIT），通过 npm 下载且禁用安装脚本。包版本与完整性由锁文件记录；
未额外绑定 Git commit，没有把移动分支当作固定源码版本。

复用 Pi 的 `Agent` 工具循环、参数 schema 处理和等待式事件订阅；
应用自研工作区授权、文件路径策略、有限预算、IPC、日志和中文证据界面。
不声称自研模型、第二套 Agent 内核或生产使用经历。历史下方 Stage 2 的单次传输描述
保留作为阶段记录，当前调用路径已改为 Pi 内核驱动的传输。

核对依据是已安装发行包的 `dist/agent.d.ts`、`dist/agent.js`、
`dist/types.d.ts` 和 `dist/agent-loop.js`；npm 元数据仓库是
`https://github.com/earendil-works/pi.git` 的 `packages/agent`。
没有运行本阶段的单测、类型检查、lint、打包、端到端或真实模型测试。
源码阅读和依赖安装不是兼容性或安全性验收。发行前仍需保留上游许可证和做传递依赖审计。

## 第四阶段复用补充（2026-10-10）

新增固定版本 `diff@9.0.0`（jsdiff，BSD-3-Clause），用于客户端逐行差异展示，
不是文件写入或审批执行器。版本、许可证及导出接口依据已安装包元数据与类型文件；
完整上游版权与许可证在发行时保留，依赖下载禁用安装脚本。
本阶段应用编写提案审批、一次性授权、写入状态与有界文件策略，继续复用唯一 Pi 内核。
未运行任何新增测试、编译、打包或真实模型请求，不能据此声称第三方兼容性已验证。

| Dependency / reference | Version | License | Reuse boundary |
| --- | --- | --- | --- |
| Electron | 44.7.0 | MIT, plus bundled third-party notices | Desktop runtime and renderer sandbox |
| Electron Forge official Webpack/TypeScript template and CLI | 8.0.1 | MIT | Generated build configuration and packaging |
| React / React DOM | 18.3.1 | MIT | Renderer components |
| lucide-react | 1.54.0 | ISC | UI icons |
| electron-squirrel-startup | 1.0.1 | Apache-2.0 | Windows installer startup handling |
| Playwright test | 1.64.0 | Apache-2.0 | Development-only packaged Electron automation |
| @earendil-works/pi-ai | 1.1.0 | MIT | OpenAI-compatible streaming transport, normalized transcript and events; imported in main only |
| openai (Pi dependency) | 7.19.0 | Apache-2.0 | HTTP/SSE SDK used by Pi; no separate application Agent loop |

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
design. Stage 1 contains no Pi integration. Stage 2 imports the exact published
`@earendil-works/pi-ai@1.1.0`; its installed package points to
`https://github.com/earendil-works/pi.git`, directory `packages/ai`.
The implementation uses published `api/openai-completions.stream` and
`utils/transcript.normalizeContext`, not assumed legacy root `stream`/`getModel`
interfaces. It adds application policy and lifecycle coordination, not a second
Agent kernel. The package release is pinned; a Git source commit was not separately
resolved. Electron bundling/runtime compatibility and end-to-end behavior have
not been tested in this iteration. Design and source inspection are not API tests.
