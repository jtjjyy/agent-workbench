# 桌面交付说明

初始源码阶段只完成源码、启动入口和打包参数，没有执行测试或运行验收。2026-10-12 后续桌面更新执行了编译与 Windows 打包，编译包含 Webpack 自带类型检查；具体部署与启动结果见下方更新记录，不等于完整功能验收。

## 2026-10-12 更新结果

- 当前版本 `0.2.0`，最终 `npm run make -- --platform=win32 --arch=x64` 退出码为 0。
- 产物为 `out/make/squirrel.windows/x64/Agent Workbench-0.2.0 Setup.exe` 和 `out/make/zip/win32/x64/Agent Workbench-win32-x64-0.2.0.zip`。安装器已生成但没有执行安装验收。
- 本机独立部署位于 `D:\CODEX\DesktopClients\AgentWorkbench\releases\0.2.0-20261012-151053-5faadaed`，桌面“开发者智能体工作台”及本项目另外两个已有入口指向其中的 EXE，不依赖 `npm start`。
- 15:10 启动记录达到 `ready`、错误码为空，实际主窗口标题为“开发者智能体工作台”；随后通过桌面快捷方式再次启动仍聚焦同一窗口。仅确认当前启动环境，未覆盖另一宿主或安装器启动路径。
- 旧配置与会话迁移完成，迁移状态为 `migrated`，当前文件长度分别为 256 和 195751 字节。旧数据和原始快捷方式另备份于 `D:\CODEX\DesktopClients\AgentWorkbench\update-backups\20261012-143455`，应用内迁移备份另存于实际数据目录的 `desktop/backups`。
- 当前实际业务目录为 `C:\Users\86150\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Roaming\agent-workbench\data-v1`。此次不展示设置或会话正文，不发起模型请求。
- 没有运行测试、Lint、独立类型检查或完整功能验收；应用内代码验证和旧 PowerShell 工具仍停用。没有提交或推送 Git。

## 数据目录与迁移

开发版、便携版和安装版的业务数据统一位于 Electron `appData` 下的 `agent-workbench/data-v1`，Windows 通常为 `%APPDATA%\agent-workbench\data-v1`。主进程使用原生 `realpathSync.native` 解析系统重定向后的运行目录，并从实际运行目录的父目录确定业务目录；应用内桌面数据面板显示实际路径。事件、模型设置、任务、变更集、知识和技能服务都使用同一稳定根目录。主入口在 ready 和单实例锁之前把 Electron 的 `userData`、`sessionData` 指向 `agent-workbench/runtime`；缓存和浏览器 profile 不列入业务备份。原 `userData` 路径提前保存用于迁移。显式 E2E 参数仅使用指定隔离目录，不迁移正常用户数据。

Windows 应用容器可能把表面 AppData 路径映射到 `LocalCache`，甚至同一旧目录中的配置和会话分别位于不同物理位置。主进程只对固定的系统运行目录和旧数据候选目录进行原生解析，解析前逐层拒绝符号链接及非目录项；首次迁移中的精确白名单文件还会逐个解析，拒绝特殊文件和多链接文件，再交给存储层检查实际路径、目录身份与读取句柄。不会把该兼容处理用于工作区、用户备份包、恢复目标或渲染进程传入的任意路径。不同启动宿主可能得到不同的系统映射，不能据此承诺跨宿主自动共用数据。

迁移识别此前 `userData`、`<appData>/Agent Workbench` 和 `<appData>/agent-workbench`。稳定目录已有业务数据时跳过迁移，不覆盖新数据。首次迁移先在 `desktop/backups` 保存 `migration-v1-*.awbackup.json`，再按白名单复制；旧目录始终保留。`desktop/metadata-v1.json` 记录数据版本、应用版本和迁移结果；失败会阻断启动，保留旧目录、备份和必要的失败标记，需人工处理后重新启动。

## 最终接口

`src/shared/desktop.ts` 导出 `DesktopBridge`、`DesktopInfo`、`DesktopResult`、`DesktopBackupRequest`、数据类别、中文错误码映射与请求校验器。

```ts
interface DesktopBridge {
  readDesktopInfo(): Promise<DesktopInfo>;
  completeSetup(): Promise<DesktopResult>;
  exportDiagnostics(): Promise<DesktopResult>;
  backupDesktop(request: DesktopBackupRequest): Promise<DesktopResult>;
  restoreDesktop(): Promise<DesktopResult>;
}
```

`DesktopService(options)` 实现上述接口，另提供 `initialize()`、`info()`、`backup()`、`restore()`、`recordStartupStage(stage, code?)`、`waitForIdle()`。options 接收稳定 `dataDir`、`version`、旧目录候选、本地设置读取与凭据可用性布尔回调、文件对话框、恢复确认及 schema 校验器。

维护回调由 coordinator 提供 `withMaintenance<T>(operation)`、`isTaskActive()`、`requireRestart()`。`withMaintenance` 在异步执行前设置 `changingSettings`，并检查 `pendingSubmissions` 与活动任务；备份、恢复和首次配置均通过该入口。关闭时先请求 coordinator 停止，再等待桌面队列完成，最后释放顶层 browser。

主入口调用 `registerHandlers(ipcMain, coordinator, webContents, rendererUrl, desktop)`，窗口关闭时清理 handlers，窗口重建时重新注册。任务和变更集作为 `RunCoordinator` 构造函数末尾两个可选参数传入。App、preload、contracts、IPC 的最终对齐由主 Agent 负责；`DesktopPanel` 的 `reloadKey`、`onRestartRequired` 扩展也由主 Agent 维护。

## 首次配置与诊断

未保存模型设置、配置不可读取、DeepSeek 密钥不可解密或数据发送未授权时，首次配置不会标记成功。模拟模式明确显示为本地模拟，真实请求未验证。完成配置只证明本地配置条件满足，不证明服务端密钥有效。

启动阶段和安全错误码保存在 `desktop/startup-v1.json`；启动失败不清理原数据，不打印原始错误对象。安全诊断只导出固定字段：版本、平台、架构、配置可用性、迁移状态、启动阶段、错误码和备份上限。诊断排除密钥、API 配置、密文、绝对路径、任务正文、会话和任意日志。

## 选择性备份与真实恢复

类别为 `settings`、`tasks`、`conversations`、`memories`、`skills`。`tasks` 始终使用同一个类别携带任务及变更审批、验证、交付证据：

| 类别 | 精确白名单路径 |
| --- | --- |
| settings | `settings/model-v1.json` |
| tasks | `tasks/tasks-v1.json`、`changes/change-sets.v1.json` |
| conversations | `events/conversation-v1.jsonl` |
| memories | `knowledge/memories-v1.json` |
| skills | `skills/settings-v1.json` |

备份为版本化 JSON 包，保存逐文件长度、SHA-256 和 base64 内容。文件包最大 64 MiB，解码数据合计最大 32 MiB；各文件另有上限。任务使用任务记录 schema，变更集使用 `isChangeSetJournal()`，事件先判断 `validateEventEnvelope(value).ok` 再读取已校验信封。未知任务文件布局会拒绝备份，不静默省略。

恢复在修改当前文件前校验 schema、版本、大小、哈希、重复路径及精确白名单，拒绝路径穿越、符号链接、硬链接与特殊文件。对话框结束后重新取得维护锁并检查活动任务，防止期间提交竞态。先保存全部受支持的当前数据到 `desktop/backups/restore-*/before-restore.awbackup.json`，暂存待恢复文件，再替换选定类别。失败保留安全备份和移出的原文件，并尝试按内容哈希恢复原文件；多文件恢复不保证进程崩溃时的原子性。未完成或失败的恢复标记阻断后续启动，避免把半恢复状态当作正常数据。

成功恢复会要求 coordinator 拒绝继续提交，清除首次配置确认，关闭客户端后重新启动才能使用。备份包含设置的系统密文及可能为明文的任务、会话和变更内容，应仅保存在用户信任的位置。密钥通常只可由同一电脑、同一系统账号解密，不能保证跨机或跨账号恢复。工作区文件、项目索引、任意日志和用户技能定义不属于本次备份白名单。

恢复前另保存 `before-restore-metadata-v1.json`；失败时尝试恢复原文件和首次配置元数据。任一恢复失败都保留失败标记并阻断启动，不能仅凭部分文件恢复就宣称回滚成功。此处仅针对应用数据恢复流程，不提供工作区代码修改的通用自动回滚。

## 明确启动入口

开发入口会调用 `npm start`，包含源码编译及项目已有自动检查；初始源码阶段没有执行该入口，本次更新使用下方独立打包入口：

```powershell
.\scripts\start-desktop-dev.ps1
```

便携版默认路径与 Forge `name`、`executableName` 对应，指向本项目的 `out\Agent Workbench-win32-x64\agent-workbench.exe`，不存在时直接失败，不搜索旧 stage1 产物：

```powershell
.\scripts\start-desktop-portable.ps1
.\scripts\start-desktop-portable.ps1 -ExecutablePath 'D:\明确的当前产物目录\agent-workbench.exe'
```

该便携启动脚本使用 `WindowStyle Hidden`，应用本身正常显示；它不会修改桌面快捷方式。安装版入口为使用当前源码生成的 Squirrel 安装产物，安装后启动同一 `agent-workbench.exe`。没有配置发布签名。

更新入口复制当前构建到独立版本目录，比较可执行文件与 `app.asar` 的 SHA-256，备份本项目已有快捷方式后更新它们。不会覆盖其他项目的快捷方式，失败版本和入口备份保留供排查：

```powershell
.\scripts\update-desktop-client.ps1 -InstallationRoot 'D:\CODEX\DesktopClients\AgentWorkbench' -Launch
```

`-Launch` 只请求显示客户端，不表示已经启动成功。编译、打包、部署和窗口启动应分别记录，不用其中任一步的成功替代其他步骤。本次仍不运行测试、Lint、独立类型检查或真实模型请求；应用内代码验证和旧 PowerShell 工具仍停用。
