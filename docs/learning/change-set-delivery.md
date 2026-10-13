# 变更集交付接口

本模块为 Pi 运行时提供结构化多文件变更、审批、验证证据和本地交付核对。它独立于 `TaskStore`，通过窄接口与任务协调器连接；主进程只应把实际已授权的 `ChangeSetService` 传入 Provider。

## Provider 接入

Provider input 保持以下可选字段，末尾追加即可：

```ts
taskId?: string
tasks?: TaskAccess
resumeContext?: string
changes?: ChangeSetAccess
```

当前 runtime 的实际工具装配要求 `changes` 是本地 `ChangeSetService` 实例，`tasks` 只需要 `TaskAccess`：

```ts
interface TaskAccess {
  get(id: string): Promise<TaskRecord>
  updatePlan(id: string, steps: TaskPlanStep[]): Promise<void>
}
```

运行编号和 Pi 的原始 `toolCallId` 是所有工具轨迹、命令审批和变更审批的共同身份。runtime 不再为工具调用生成替代 UUID。

本地锁定的 `@earendil-works/pi-agent-core` 1.1.0 源码中，`dist/agent.js:432` 的 listener 循环逐个 `await listener(event, signal)`；`dist/agent-loop.js:378` 先 `await` 发出 `tool_execution_start`，再准备和执行工具。因此 started 回调会等待 `onTool` 保存任务检查点和事件；存储失败时 runtime 的 `fail` 会中止本地信号，`beforeToolCall` 随后阻止执行。该保证依赖此锁定版本，升级 SDK 必须重新检查源码时序，不能假定任意版本都等待 subscriber。

runtime 的有限预算从原来的最多 8 次模型请求、12 次工具调用提高为 24 次模型请求、48 次工具调用；累计工具正文上限从 48000 提高为 240000 个序列化字符，上下文上限从 120000 提高为 180000。此调整会增加任务允许的耗时和模型费用，预算并非 token 或价格估算，也不保证复杂任务能在预算内完成。压缩保留 system、最新 user 和最近完整工具批次，按完整批次移除旧上下文；必要上下文仍超限时停止并保留已有检查点。工具结束先保存 completed 记录，再判断累计结果预算，避免丢失已发生的副作用证据。

## ChangeSetService

构造函数和默认策略：

```ts
new ChangeSetService(baseDir: string, policy?: { allowVerification: boolean })
```

`allowVerification` 默认是 `false`。关闭时 `run_verification` 返回 `not_run`，不会创建子进程，也不会写入伪造的通过或失败证据。runtime 同时停用旧 `run_powershell` 入口，避免通过脚本包装测试、类型检查、构建、打包或其他验证命令。

变更与审批：

```ts
request(
  workspace: WorkspaceState,
  identity: { runId: string; taskId: string; toolCallId: string },
  operations: unknown,
  signal: AbortSignal,
  publish?: PublishChangeSet,
): Promise<ChangeSetOutcome>

readPending(): PendingChangeSet | null
decide(request: DecideChangeSetRequest): DecideChangeSetResult

readPendingChangeSet(): Promise<PendingChangeSet | null>
decideChangeSet(request: DecideChangeSetRequest): Promise<DecideChangeSetResult>
readChangeSets(taskId?: string): Promise<ChangeSetRecord[]>
```

`readPendingChangeSet`、`decideChangeSet` 和 `readChangeSets` 是 IPC/preload 的对齐别名。完整预览只在内存待审批状态中提供，事件只携带身份、摘要状态、代次和 TTL，不携带正文。

交付核对有两种调用形式：

```ts
bindWorkspace(taskId: string, workspace: WorkspaceState, signal?: AbortSignal): Promise<void>
getDelivery(taskId: string, workspace?: WorkspaceState, signal?: AbortSignal): Promise<ChangeDelivery>
deliver(workspace: WorkspaceState, identity: ChangeIdentity, signal?: AbortSignal): Promise<ChangeDelivery>
```

runtime 已在本轮绑定工作区，因此面板或同一实例可以调用 `getDelivery(taskId)`；协调器也可以显式传入当前授权工作区。若没有绑定工作区且省略第二个参数，服务会拒绝核对。

只有以下条件同时成立时 `ChangeDelivery.canComplete` 才为 `true`：变更文件的实际哈希全部为 `current`，不存在 `pending`、`applying`、`partial` 或 `unknown`，当前代次和文件快照与验证证据一致，验证状态为 `passed` 且退出码为零，并且任务没有其他工作区身份的变更记录。默认验证策略关闭时交付必为 `not_run`，不能完成。

## 工具

`createChangeSetTools(workspace, service, context)` 返回三个 Pi 工具：

```ts
propose_change_set
run_verification
deliver_changes
```

`propose_change_set` 支持 `create`、`update`、`delete`、`rename` UTF-8 文本文件。每批最多 20 项，每文件最多 32 KiB 和 12000 个 UTF-16 单元，前后正文总量最多 512 KiB。更新、删除和重命名要求 `beforeSha256`；创建和重命名目标必须不存在。审批绑定运行、任务、原始工具调用、工作区根身份、全部路径和哈希。

应用前会再次执行整批和逐项 preflight。每项结果独立记录为 `applied`、`conflict`、`failed`、`unknown` 或 `not_applied`。一旦出现部分或未知结果，服务保存检查点并停止后续自动重放；不宣称原子性，也不自动回滚。

`run_verification` 只接受有界的具体 PowerShell 命令，复用 `CommandApprovals` 和 `executePowerShell`，记录退出码、状态、尝试次数、修复次数、代次、快照摘要和脱敏输出。验证失败结果仍作为有效工具结果返回给模型。变更代次或文件哈希变化会使旧证据失效，失败修复最多三次。

`deliver_changes` 复读实际文件哈希并返回变更集合、逐文件状态、验证状态、证据和风险。它只生成本地报告，不执行 Git commit 或 push。

## 持久化与 Agent3 对接

存储文件名为：

```ts
CHANGE_SET_STORE_FILENAME = 'change-sets.v1.json'
```

可供恢复和备份校验使用的导出为：

```ts
interface ChangeSetJournal {
  version: 1
  generation: number
  repairAttempts: Record<string, number>
  changeSets: ChangeSetRecord[]
  verifications: VerificationRecord[]
}

isChangeSetJournal(input: unknown): input is ChangeSetJournal
```

日志串行写入临时文件后同步并替换正式文件，只保存操作摘要、哈希、状态和脱敏验证输出，不保存完整正文。恢复时 `pending` 转为 `cancelled`，`applying` 和运行中的验证转为 `unknown`，旧审批和副作用调用不会重放。容量上限为 8 MiB，达到上限会停止继续操作，不裁剪交付证据。

## UI Bridge

`ChangeSetReview` props：

```ts
interface ChangeSetReviewProps {
  bridge?: ChangeSetBridge
  activeRunId: string | null
  taskId?: string
  blocked?: boolean
  reloadKey?: number
  events?: readonly { type: string; sequence: number }[]
  onPendingChange?: (pending: boolean) => void
}
```

UI 在批准前会重新读取并比较完整 JSON 预览与身份，检查 TTL，并使用 `decideChangeSet` 一次消费决定。待审批区显示完整 Diff，历史记录显示逐项状态；历史正文不存盘，因此重启后的历史记录不能重建完整 Diff。验证状态由交付报告或任务面板提供。

## 未覆盖风险与本轮状态

当前命令执行仍依赖 PowerShell 进程和工作区权限，不是操作系统级沙箱；凭据检测是有界启发式，不能证明任意秘密都能识别。文件变更不提供通用回滚，竞态或进程崩溃可能留下 `unknown`，必须人工核对。存储文件的 Unix mode 在 Windows 上不能替代 ACL。协调器不会把变更集验证证据视为对旧 `replace_text` 或其他任意命令的覆盖；含这些未覆盖操作的任务保持未完成。

本轮按要求没有运行测试、类型检查、构建、打包、真实模型请求或其他验证；以上接口和策略尚未被执行验证。
