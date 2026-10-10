# Stage 0–1 交付记录

日期：2026-10-10，Asia/Shanghai。状态：已完成批准的 Stage 0–1 开发、复审和构建验收。
这只是完整项目的第一条可运行链路，不代表完整产品交付。

源码版本：`9b79c8dffe7664b83901a6d93a91b4fb72cf75a3`。
分支：`stage1/vertical-slice`。此前的事件存储提交为 `ab005a8`，界面提交为 `8c44766`。
本报告及证据另作文档提交。保留原设计、计划和 `main`，不自动合并。

## 当前范围

已实现 Windows 桌面会话、确定性 Mock 流式输出、事件轨迹、版本化本地日志、
请求去重和正常关闭后恢复。只有一个 `default` 会话。

**这不是完整 Agent 产品。** 尚未接入真实模型、Pi、代码工具、检索、MCP、
多 Agent、模型配置、迁移或备份。没有模型成功率、成本或性能收益数据。

## 验证记录

执行者为开发助手及子 Agent；不代表用户已亲自完成学习练习。

| 检查 | 当前证据 |
| --- | --- |
| `npm ci` | 退出 0，按锁文件安装成功 |
| 类型检查与 Lint | 最终源码均退出 0 |
| 单元、组件及 IPC 集成 | 9 个测试文件、217 项全部通过；JSON 报告复跑亦通过 |
| 实际打包 E2E | 最终包 3/3 通过，8.8 秒；不是组件 Mock 冒充桌面 E2E |
| 特殊路径实测 | 将程序复制到含空格、`#`、`%20` 的目录；启动、提交、日志比对、退出 0 均通过 |
| 界面检查 | 最终包 1280×800、600×480：自动重叠/边界断言通过，截图已人工查看 |
| Windows 构建 | 最终 `npm run make` 退出 0，重新打包并生成 Squirrel 和 ZIP |
| 安装、升级、卸载 | 未测试 |
| 真实模型调用 | 未执行，当前不需要密钥 |

所有测试均使用确定性本地 provider。桌面 E2E 覆盖真实 preload/IPC、非法请求拒绝、
增量显示、正常关闭后会话与轨迹精确恢复、模拟失败后继续提交、重启前后请求去重。
磁盘失败的覆盖来自注入失败存储的运行时/组件测试，不是整机磁盘耗尽实验。
`npm ci` 验证了此工作区的锁文件安装；没有声称另做了一次全新 Git clone 验收。

原始输出、结构化测试报告和截图见 `stage1-evidence/`。测试耗时只是本机本次观测，
不是产品性能基准。构建有上游弃用警告、测试有终端颜色环境警告，退出码仍为 0。

## 工程事实与限制

- Node 24.15.0、Electron 44.7.0、Forge 8.0.1、React 18.3.1、
  TypeScript 6.0.3、Playwright 1.64.0；版本以提交的锁文件为准，不宣称为最新版。
- 独立审查发现的 3 项 P2：特殊字符路径加载、日志失败状态、持久化顺序测试的假阳性。
  已修复并通过独立定向复审；另修复了非法日志尾部可能被静默截断的问题。
- 开发依赖审计有 9 项发现：7 high、2 moderate；仅生产依赖审计为 0。
  这不是整套桌面程序的安全认证。
- 安装包未签名；保留用于 E2E 的 inspector fuse，不作为生产加固发行版。
- 日志是明文；没有逐事件 fsync，不承诺断电安全或自动回滚。
- Renderer sandbox 不等同于未来命令执行工具的操作系统隔离。
- 没有用户取消按钮、任意工具执行、完整运行恢复、日志导出、升级迁移或备份功能。
- `connect-src 'none'` 与本地 provider 不等于已做整机网络隔离审计。

## 可运行文件

本机源构建目录：

```text
D:\CODEX\Worktree\agent-workbench-stage1\arduino-agent-agent-agent-https-ai
```

相对此目录：

- 程序：`out/Agent Workbench-win32-x64/Agent Workbench.exe`
- 安装包：`out/make/squirrel.windows/x64/Agent Workbench-0.1.0 Setup.exe`
- ZIP：`out/make/zip/win32/x64/Agent Workbench-win32-x64-0.1.0.zip`

为便于使用，安装包和 ZIP 另复制到原会话目录的 `outputs/stage1-downloads/`。
二进制不放入 Git 源码提交。安装包 153,684,992 字节，ZIP 158,272,066 字节；
安装包签名检查结果为 `NotSigned`。未执行安装器，不宣称安装成功。

SHA-256：

```text
Setup.exe CFCE9D88952796CD1644D8E68438A20678099EC0C5F6549AA3C4EB1A9298180D
ZIP       E804515E4D0B35B21729D3593523C753FD48A191FF949C424F56C9F010DAABF1
app.asar  D3FEADB04D87952CF22189BCF82F1B32789229A8D7A788EB781F85165AAC5F28
```

已额外比对 ZIP 内 `resources\app.asar`，与实际受测包哈希一致。
项目许可证和第三方说明随包位于 `resources/`。

## 演示与学习

建议先使用 ZIP，完整解压后打开其中的 `Agent Workbench.exe`，不要只移动 EXE。
输入一段文字，观察 Mock 流式回复及右侧事件轨迹；关闭再打开，观察会话恢复。
输入 `[simulate-failure]` 可触发已记录的模拟错误，之后仍可提交正常文字。
这是建议的手动演示，不代表你已经亲自完成。

## 文档入口

- `README.md`：本地运行和构建命令。
- `docs/stage1-engineering-notes.md`：实际架构、决策、故障复盘和复用边界。
- `docs/learning/stage1-checkpoints.md`：知识、需求、模块、证据、面试问题映射。
- `THIRD_PARTY_NOTICES.md`：主要依赖的来源和许可边界。

学习练习仍标记为未亲自完成。第一项练习是沿
`Composer → preload → IPC → RunCoordinator → journal → reducer`
解释一次请求，重点回答“为什么先持久化，再通知界面”。
后续按已批准路线接入真实模型和单 Agent 工具循环，不同时维护第二套内核。
