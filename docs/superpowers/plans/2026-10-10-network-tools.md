# 联网工具解耦 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DeepSeek Agent 在未选择代码工作区时也能使用受限的网页搜索和网页读取。

**Architecture:** 将运行时授权拆成 `networkAuthorized` 和 `workspaceAuthorized` 两层。网页搜索/读取只依赖数据外发同意；代码、知识、文件、命令和浏览器工具继续依赖工作区授权。复用已有 `createWebTools` 的网络安全限制，不引入新的网络客户端。

**Tech Stack:** TypeScript、Electron 主进程、`@earendil-works/pi-agent-core`、TypeBox、Vitest（本轮按项目约定不执行测试命令）。

## Global Constraints

- 使用简体中文作为新增用户可见文案和文档语言。
- 不使用聊天中暴露的 API 密钥。
- 不改变工作区路径限制、文件审批、命令审批和浏览器交互审批。
- 外部网页内容视为不可信数据，不自动写入记忆或项目索引。
- 本轮不运行测试、类型检查、Lint、构建、打包或真实联网请求。
- 不自动提交或推送 Git。

---

### Task 1: 建立授权分层回归用例

**Files:**
- Create: `tests/unit/pi-agent-runtime.test.ts`
- Modify: `src/main/agent/pi-agent-runtime.ts`

**Interfaces:**
- Consumes: `runPiAgent(input, settings, apiKey, signal, onDelta, ...)`。
- Produces: 工具注册条件可被测试观察，网络工具与工作区工具独立启用。

- [x] **Step 1: 编写三个授权场景的测试骨架**

  使用授权策略和联网工具工厂的纯函数测试，覆盖：
  - 无工作区、已同意外发：存在 `web_search`、`web_fetch`，不存在 `read_file`、`run_powershell`、`browser_open`。
  - 无工作区、未同意外发：不存在 `web_search`、`web_fetch`。
  - 有工作区、已同意外发：授权策略同时返回网络和工作区权限。

- [x] **Step 2: 按项目约定保留测试文件但不执行测试命令**

  本轮遵守“暂不运行测试验证”的项目约定；测试代码只作为后续恢复验证时的固定回归入口。

- [x] **Step 3: 修改运行时授权分支**

  将现有单一 `authorized` 拆成：

  ```ts
  const workspaceAuthorized = !!input.workspace?.root && input.workspace.dataEgressConsent;
  const networkAuthorized = input.workspace?.dataEgressConsent === true;
  const tools = workspaceAuthorized ? createReadonlyTools(input.workspace!) : [];
  if (networkAuthorized) tools.push(...createWebTools({
    root: input.workspace?.root ?? null,
    dataEgressConsent: true,
  }));
  ```

  其余工作区工具保持使用 `workspaceAuthorized`，联网工具改用 `networkAuthorized`。

- [x] **Step 4: 同步系统提示的能力说明**

  在未授权工作区但已授权联网时，系统提示应明确“可以搜索和读取公开网页，但不能读取本地文件”；不能再笼统地声明只能聊天。

- [x] **Step 5: 记录不运行验证的状态**

  在交付说明中明确列出新增回归用例路径，以及本轮未执行测试和真实联网请求。

### Task 2: 补齐用户可见的联网状态说明

**Files:**
- Modify: `src/renderer/components/ModelSettingsDialog.tsx`
- Modify: `src/renderer/components/WorkspaceBar.tsx`
- Modify: `src/renderer/components/App.tsx`
- Modify: `src/shared/zh-CN.ts`

**Interfaces:**
- Consumes: 现有 `PublicModelSettings.dataEgressConsent` 和 `WorkspaceState`。
- Produces: 用户能区分“联网已授权”和“工作区工具已授权”。

- [x] **Step 1: 检查现有数据外发文案**

  保留现有确认机制，不新增隐含授权；将说明改为同时列出“对话、网页请求、已授权工作区工具结果”的外发范围。

- [x] **Step 2: 增加工作区状态区分**

  无工作区但已同意数据外发时，显示“联网工具已授权，工作区工具未启用”；工作区已授权时继续显示工作区工具状态。

- [x] **Step 3: 确保本地模拟模式不伪造联网能力**

  本地模拟模式仍不注册联网工具，并在设置或状态中明确“本地模拟不会发起网络请求”。

### Task 3: 更新学习文档与交付记录

**Files:**
- Modify: `docs/learning/stage10-tools.md`
- Create: `outputs/network-tools-delivery.md`

**Interfaces:**
- Consumes: 设计文档、运行时授权规则和回归用例路径。
- Produces: 中文的知识点、产品需求、实现模块、测试证据和面试问题映射。

- [x] **Step 1: 记录事实与建议的区别**

  事实：当前项目复用 `web_search`、`web_fetch`；建议：联网授权与工作区授权分层；假设：DuckDuckGo HTML 页面在目标网络环境可访问。

- [x] **Step 2: 记录安全边界**

  明确网络读取不是沙箱，网页内容不可信，私网地址过滤不是完整 SSRF 防护，且不保证第三方站点可用。

- [x] **Step 3: 记录验证状态**

  写明本轮未运行测试、类型检查、构建、打包或真实联网请求，避免伪造证据。

## Self-Review Checklist

- [x] 网络工具不再依赖 `workspace.root`。
- [x] 工作区工具和浏览器审批条件没有被放宽。
- [x] 未同意数据外发时仍然不注册联网工具。
- [x] 本地模拟模式不会伪造联网能力。
- [x] 文档没有声称网络工具提供完整沙箱或完整 SSRF 防护。
