# 第五阶段：记忆、项目知识库与增量索引实施计划

> **For agentic workers:** 本阶段按现有工作区直接实施；源码与测试用例可以写入，但在用户恢复验证前不得运行测试、类型检查、lint、构建、打包或真实模型请求。

**目标：** 为单 Agent 工作台增加用户可管理记忆、项目知识摘要、基于文件指纹的增量索引和带来源的本地知识检索。

**架构：** 主进程维护 JSON 文件格式的用户记忆和项目索引，索引内容只来自已经授权的工作区。增量同步按相对路径、文件大小、mtime/ctime、文件身份和 SHA-256 判断是否复用；发生变化的文件重新读取，删除的文件从索引移除。Pi 只通过两个只读知识工具查询索引，不获得任意索引文件路径或写入权限。

**技术栈：** Electron 主进程、TypeScript、React、现有 JSONL 事件日志、现有工作区安全策略、Pi Agent Core 1.1.0。

## 全局约束

- 所有界面、错误、文档和进度说明使用简体中文。
- 记忆和索引均为本地明文应用数据；不把它们描述为安全存储，也不自动向模型发送全部内容。
- 只有工作区外发授权存在时才允许知识工具向模型返回文件片段；用户记忆只有用户明确保存后才可进入知识检索结果。
- 索引来源只保存相对路径、行号、SHA-256、有限片段和时间；不保存任意绝对路径、密钥或模型原始参数。
- 复用 `readonly-tools.ts` 的根指纹、路径、链接、敏感文件、UTF-8 和大小策略，不维护第二套文件安全规则。
- 不实现向量数据库、Embedding、远程知识库、自动长期记忆写入或多 Agent 产品能力。
- 当前用户要求暂停验证：本阶段不得运行测试、类型检查、lint、构建、打包、浏览器自动化或真实模型请求。

---

### 任务 1：共享协议与知识工具名称

**文件：** `src/shared/knowledge.ts`、`src/shared/workspace.ts`、`src/shared/contracts.ts`、`src/shared/zh-CN.ts`、`src/renderer/agent-api.d.ts`。

**产出：** `KnowledgeState`、`ManagedMemory`、`KnowledgeSearchResult`、`KnowledgeAccess`；新增 `search_knowledge` 和 `read_project_knowledge` 工具事件与 Bridge 方法。

### 任务 2：记忆存储与项目增量索引

**文件：** `src/main/knowledge/memory-store.ts`、`src/main/knowledge/project-index.ts`、`src/main/knowledge/knowledge-service.ts`、`src/main/index.ts`、`src/main/agent/run-coordinator.ts`。

**产出：** `KnowledgeService`，提供 `readState`、`sync`、`search`、`readMemories`、`saveMemory`、`deleteMemory`；同步任务不改变用户源文件。

### 任务 3：Agent 知识工具和 IPC

**文件：** `src/main/tools/knowledge-tools.ts`、`src/main/agent/pi-agent-runtime.ts`、`src/main/agent/deepseek-provider.ts`、`src/main/ipc/register-handlers.ts`、`src/preload/index.ts`。

**产出：** Agent 只能用授权工作区知识检索和项目摘要工具；工具返回来源证据和索引新鲜度，不直接暴露索引文件。

### 任务 4：中文知识面板

**文件：** `src/renderer/components/KnowledgePanel.tsx`、`src/renderer/components/App.tsx`、`src/renderer/styles.css`、测试桥接夹具。

**产出：** 展示索引状态、同步按钮、用户记忆的新增/删除和来源/过期提示；同步与任务互斥。

### 任务 5：文档、测试源码和交付说明

**文件：** `docs/learning/stage5-memory-knowledge.md`、`README.md`、`THIRD_PARTY_NOTICES.md`、`outputs/第五阶段记忆知识索引说明.md`、对应 `tests/unit` 测试源码。

**验收设计：** 首次同步建立索引；第二次同步复用未变化文件；文件变更只重建对应文档；文件删除不再可检索；来源带相对路径、行号和哈希；用户删除记忆后查询不到；撤销工作区授权后知识工具不可用。上述验收仅写入计划和测试源码，当前未执行。
