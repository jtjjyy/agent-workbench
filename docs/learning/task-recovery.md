# 任务持久化与人工续接

本模块对应 2026-10-12 已确认的可靠交付设计，保持 Pi 作为唯一执行内核。任务存储、工具、恢复面板和 `RunCoordinator` 生命周期已实现；App/IPC/preload/contracts 的公共入口由主 Agent 集成。

## 文件与接口

- `src/shared/tasks.ts`：版本、严格数据校验、任务状态、真实计划、工具结果、审批和续接请求。
- `src/main/tasks/task-store.ts`：`TaskStore`，同时导出别名 `JsonTaskStore`。构造参数是完整绝对 JSON 文件路径，建议由统一应用数据目录生成 `tasks/tasks-v1.json`，不要传目录本身。
- `src/main/tools/task-tools.ts`：`createTaskTools(store, taskId): AgentTool[]`，提供 `update_task_plan` 和 `read_task_state`，只绑定一个任务。
- `src/renderer/components/TaskPanel.tsx`：中文任务面板，可经局部 bridge 读取任务、暂停、取消、续接和读取交付证据。
- `src/main/agent/run-coordinator.ts`：在构造参数末尾接收可选 `tasks?: TaskStore, changes?: ChangeSetService`；在 task/tool/approval/event 发布前等待对应持久化，维护操作与 submit 互斥。

存储方法均异步，需要等待结果：

| 方法 | 返回 | 调用约定 |
| --- | --- | --- |
| `startRun(taskId \| undefined, prompt, workspaceRoot, runId)` | `Promise<TaskRecord>` | 新任务用 `undefined`；续接先调用 `prepareResume`，保留原始 prompt，并生成全新 runId；未绑定工作区用 `null` |
| `recordTool(taskId, progress)` | `Promise<void>` | `started` 必须在副作用前写入；`completed` 必须在确定结果后写入；可携带 runId 作运行归属校验 |
| `recordApproval(taskId, type, payload)` | `Promise<void>` | 保存请求和决定，payload 至少有 runId、approvalId、toolCallId；请求还要有 expiresAt，决定还要有 decision |
| `updatePlan(taskId, steps)` | `Promise<void>` | 整体更新真实步骤，保留稳定 id 与历史事实；禁止固定假计划 |
| `appendContext(taskId, text)` | `Promise<void>` | 仅追加当前任务的有限摘要，不传整个会话历史；不含密钥 |
| `finishRun(taskId, status, error?)` | `Promise<void>` | 暂停、取消、中断、完成、失败是不同状态；当前运行未知副作用不允许声明完成 |
| `interruptActive()` | `Promise<void>` | 活动任务转为 interrupted，待审批失效；应在运行停止后调用 |
| `list()` | `Promise<TaskRecord[]>` | 更新时间倒序、深复制；不返回可修改的内部引用 |
| `get(taskId)` | `Promise<TaskRecord>` | 严格读取一个任务；不存在时抛 `TASK_NOT_FOUND` |
| `prepareResume(taskId, workspaceRoot, acknowledgeUnknown)` | `Promise<TaskRecord>` | 核对同一工作区和未知副作用，生成本进程的一次续接许可；不启动模型、不重放调用 |

`workspaceRoot` 经绝对路径校验、`realpath` 和 `lstat` 目录检查，并保存 `dev:ino:birthtimeNs` 身份；Windows 比较路径使用规范化小写形式。不会尝试以 `'r'` 打开目录。启动或续接会重新核对规范路径和目录身份，协调器仍须验证当前工作区授权；目录身份字段不能代替授权服务。

## 主 Agent 的集成顺序

1. 在单实例应用中创建一个存储实例。首次调用会读取并扫描 running/waiting_approval，将其持久化为 interrupted；读写或版本错误必须阻止开始任务，不得回退到空存储。
2. `RunCoordinator` 构造参数末尾可传 `tasks?: TaskStore, changes?: ChangeSetService`。它会先持久化任务运行、工具进度和审批，再发布会话事件；任务或 journal 写失败立即 abort 并拒绝后续工作。`cancelRun` 管理会话 run，任务面板另用 `pauseTask({taskId})` 和 `cancelTask({taskId})`，二者等待取消后的工具/审批回调落盘。
3. 将 `createTaskTools(store, task.taskId)` 加入本次 Pi 工具集，公共工具名称白名单和轨迹中文名称由主 Agent 接入。计划初始为空，模型按实际任务制定并维护，最多四十步，同时最多一步进行中。
4. 暂停、取消必须先中止运行并等待工具、审批和回调退出，再 `finishRun(taskId, 'paused'/'cancelled')`。两者都保留已有副作用；迟到的回调不能写入新运行。每个运行的工具回调应显式带 runId，避免把旧回调归属到续接轮次。
5. `resumeTask({taskId, acknowledgeUnknown})` 从任务存储取回原始 prompt，在主进程检查未知副作用、当前工作区授权及目录身份，生成全新 runId，并开始新的 Pi 调用。原始 prompt 经 `input.text` 独立传递，checkpoint 经 `input.resumeContext` 单独传递；不会把其他任务的任务记录或旧工具调用混进续接上下文。
6. 一般无工作区 DeepSeek 对话仍保留既有有界会话历史；任务续接不带全局历史。两种上下文用途不同。检查点和外部内容均是不可信数据，完成历史不等于当前文件证据。

面板 bridge 为局部结构接口：

```ts
interface TaskPanelBridge {
  readTasks(): Promise<TaskRecord[]>;
  pauseTask(request: { taskId: string }): Promise<unknown>;
  cancelTask(request: { taskId: string }): Promise<unknown>;
  resumeTask(request: { taskId: string; acknowledgeUnknown: boolean }): Promise<unknown>;
  getDelivery?(taskId: string): Promise<ChangeDelivery>;
}
```

传入可选 `activeRunId` 和 `blocked`。`blocked` 阻止续接；当前运行的暂停、取消仍可用。主进程拒绝时应抛出异常，或者返回 `{ ok: false }`。任务事件（排除 delta）可触发列表刷新。交付查询只在无活动任务/维护时进行，要求当前主进程已授权工作区与任务保存的规范路径及目录身份匹配；读取当前文件哈希和已有验证证据，不执行验证命令。

## 工具状态与未知副作用

工具记录用 `(runId, toolCallId)` 定位；原始 toolCallId 在一个任务的全部运行内必须唯一，不能跨续接轮次复用，也不能重复开始或结束。`phase` 区分是否已收到结束回调，`status` 区分 completed 与 unknown。completed 表示结果已被记录，不必然是工具成功；只读错误可为 completed/isError=true。

副作用分类包括 none、file_write、command、browser_interaction、unknown。已知只读工具默认 none，文件写入、命令和浏览器交互按名称保守分类，新工具默认 unknown。明确分类可由进度提供；已知副作用工具不能降为 none，结束时不能改变分类。

- 开始记录始终 unknown。进程中断后不推断执行成功或未执行。
- 副作用工具发生错误时仍保留 unknown，即使收到了结束回调也不能凭错误证明未执行。
- 部分文件写入、未知命令或浏览器结果必须设置 `progress.status = 'unknown'`，即使 `isError=false`；否则正常成功回调会被认为结果已确认。
- 所有未知副作用完整保留，不能靠截断上下文删除；面板显示完整列表，续接前要求用户勾选核对。
- 核对只保存 acknowledgedAt，不把 unknown 改为 completed。旧审批失效，不复用；旧工具不重放，不承诺通用回滚。
- `recordApproval` 接受文件、命令和 `change-set.approval.requested/decided` 事件。审批 payload 只接受有界 JSON；调用方不得传密钥、正文全文或原始错误对象。Pi 原始 `toolCallId` 原样保存，与审批绑定 ID 一致。

## 数据与故障边界

文件为 `{ schemaVersion: 1, tasks: [...] }`。严格检查字段、状态、归属、唯一标识和容量；不兼容版本或损坏记录不会筛掉后继续，也不会覆盖原文件。

完成状态不能由模型输出、停止原因或工具摘要单独授予。计划必须非空且全部步骤绑定本任务中真实、成功结束的工具 ID；计划管理/读取工具、失败调用和 unknown 不构成证据。任务还必须没有未完成或未知副作用。发生文件变更时还要有本任务变更集记录，并由 `ChangeSetService.getDelivery(taskId, workspace)` 实际读取当前文件哈希、确认所有对应变更集 applied、无未覆盖命令且验证证据 passed；否则保持 paused。单文件旧编辑或任意命令不能凭变更集报告覆盖范围，按保守策略不授予 completed。步骤工具绑定是可审计的调用关联，不是对任意步骤标题语义的机器证明。

同一任务计划内，一个工具证据 ID 最多绑定一个步骤，JSON schema 读取与写入也核对唯一性。`updatePlan` 只允许保留与旧已完成步骤的 id、title、detail、toolCallIds（含顺序）完全一致的历史证据；不允许删除、改写或把已完成步骤重置为 in_progress。续接开始不会清空旧计划，更新计划应保留历史完成步骤，仅调整未完成步骤。新建、变更或新完成的步骤所引用的成功工具必须属于当前 activeRunId，未完成步骤不能预先绑定旧轮次证据再升级为 completed。`finishRun('completed')` 使用同一证据有效性与唯一性校验，并要求全部步骤 completed。历史 JSON 无法独立证明过去的每次计划转换，不能把 schema 校验当作当前文件状态验证。

`TaskAccess` Provider 输入精确为 `{ get(id: string): Promise<TaskRecord>; updatePlan(id: string, steps: TaskPlanStep[]): Promise<void> }`，作用域由 coordinator 限制为当前 task。其他 Provider 输入：`taskId?: string`、`resumeContext?: string`、`changes?: ChangeSetAccess`。共享 `AgentProvider.onApproval` 使用 `AgentApprovalPublisher`，覆盖命令审批与 `ChangeSetEvent`；Pi 运行时要求传入真实本地 `ChangeSetService`，IPC bridge 仍使用 `ChangeSetAccess` 的只读/审批接口。

审批回调签名为 `(type: ChangeSetEvent | 'command.approval.requested' | 'command.approval.decided', payload: ChangeSetEventPayload | EventPayloads['command.approval.requested'] | EventPayloads['command.approval.decided']) => Promise<void>`。旧 `FileEditApprovals` 的工具 ID 校验也需由对应集成方接受 Pi 原始有界 ID，不能转换后使任务记录和审批绑定失配。

`withMaintenance<T>(operation): Promise<T>` 排斥活动/排队 submit、其他维护、存储故障和 `restartRequired`；恢复数据后主进程应调用 `requireRestart()`，直到重启拒绝新任务及设置/知识/skills 变更。`getDelivery(taskId)` 使用已授权工作区做只读核对。主进程可传 `isTaskActive`、`withMaintenance` 和 `requireRestart` 给桌面恢复服务。

旧变更入口 `saveMemory`、`deleteMemory`、`changeWorkspace`、`changeSettings`、`setSkillEnabled`、`syncKnowledge` 同样经过维护互斥，并拒绝关闭中、存储故障和恢复后待重启状态。维持既有返回协议：部分入口返回失败结果，其他入口拒绝 Promise；失败结果不是维护成功。

事件日志 `persist` 实际经 `journalQueue` 串行执行，在队列执行时构造序号，append 成功后才递增并通知订阅者；并发工具事件与文本 delta 不预占相同序号。写失败封锁后续事件。`shutdown` 先停止新工作，活动运行默认以 interrupted 中止（已明确暂停或取消则保留原因），等待初始化、运行队列、活动运行、维护操作及日志队列结束。

Pi 集成仍须在真正执行工具前等待 started 持久化，并在返回 Provider 结果前排空结束回调。仅向 `agent.subscribe` 传入 async 监听器不能自行证明 Pi 会等待它；主 Agent 需在其负责的运行时建立明确的执行屏障。任务存储与协调器已经提供可等待的回调，不能代替运行时对这些 Promise 的等待。

单实例内部串行操作先复制候选数据，再在同目录写独占临时文件、同步、关闭和 rename 替换。只有替换完成后才更新内存。写失败进入故障状态，后续操作拒绝；保留原文件与可能存在的临时文件，供人工检查。读取仅在文件不存在时视为首次初始化。没有跨进程文件锁；此存储须由单实例主进程独占，同步加 rename 不承诺所有平台掉电情况下目录元数据绝对持久。

任务存储路径先规范化。目录链从文件系统根目录开始逐级 lstat/realpath，拒绝符号链接、junction、非目录和不匹配的真实路径，并固定本实例观察到的目录身份；创建目录逐级进行，不用递归 mkdir 穿越未核对路径。文件只允许 nlink=1 的普通文件，读取前后同时核对路径、打开的句柄、身份、长度及修改时间，按已核对长度有界读取。临时文件使用独占创建及可用平台上的 O_NOFOLLOW，打开后、写入后和 rename 前核对句柄与路径身份；替换前后复查父目录及完整目录链，替换后确认安装的是本次临时文件。保存前还比较上次读取/写入的文件状态，外部替换、删除或修改会封锁存储，不覆盖也不回退到空记录。只有初次核对中确认父目录或文件不存在才初始化为空，读取中途的 ENOENT 是故障。

上述检查用于拒绝已发现的链接、身份变化及外部修改。Node 跨平台路径 API 没有完整的基于目录句柄的相对打开/替换能力，检查与 mkdir/open/rename 之间仍有窗口，不能承诺抵御所有本地恶意竞态。替换后的复查失败时 rename 可能已经发生，记录故障并保留可检查数据，不承诺自动回滚；数据目录仍须依赖操作系统权限与单实例独占。

每任务原始输入最多二万 UTF-16 单元；上下文最多一万二千单元和二十四条，较早上下文按条淘汰；检查点最多一万八千单元，展示计划和未知副作用节选，但完整记录仍保留。最多一千任务、一千运行/任务、两千工具/任务、一千审批/任务，JSON 总文件最多三十二 MiB。达到容量时拒绝写入而不自动丢弃历史。任务存储为本地明文，仅保存必要摘要；调用方仍负责脱敏和文件系统访问控制。

本次未运行测试、构建、类型检查、打包或真实模型请求，也未执行 git commit。恢复验证后仍需重点检查串行并发、文件写失败、损坏 JSON、重启中断、工作区切换、未知副作用核对、迟到回调、审批失效、交付代次绑定及恢复维护 gate；这些是待执行验收项，不是已通过结果。
