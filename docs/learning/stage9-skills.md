# 第九阶段：Skills

## 已实现

- 声明式 Skill 协议：名称、描述、关键词、Markdown 指令、来源和工具说明。
- 三个内置 Skill：代码仓库理解、技术资料调研、变更验证与复盘。
- 用户数据目录支持本地 `skills/<id>/SKILL.md` 定义，非法定义会被忽略。
- 启用状态持久化到 `skills/settings-v1.json`。
- 任务开始前按关键词匹配最多三个已启用 Skill，指令总长度限制为 12,000 UTF-16 单元。
- 中文 Skills 管理面板和 IPC 启停接口。

## 关键边界

Skill 是提示词和任务方法，不是权限系统。它不能新增工具、命令执行、MCP 接入或文件写入能力。实际工具集合仍由工作区授权、外发同意、审批和运行时预算决定。Skill 内容会随匹配任务发送给当前模型，因此本地 Skill 也应被当作配置数据管理。

## 学习映射

| 知识点 | 产品需求 | 实现模块 | 测试证据 | 面试问题 |
| --- | --- | --- | --- | --- |
| Skills 声明式设计 | 可复用任务方法 | `src/shared/skills.ts`、`builtin-skills.ts` | `skill-matcher.test.ts` | 为什么不允许 Skill 携带 JavaScript？ |
| 提示词工程 | 按任务注入有限方法 | `skill-matcher.ts`、`pi-agent-runtime.ts` | `skill-matcher.test.ts` | 如何避免所有 Skill 都进入上下文？ |
| 权限边界 | Skill 不能扩大能力 | `skill-service.ts`、现有工具工厂 | 未恢复验证 | 为什么提示词不能代替权限校验？ |
| 可管理性 | 用户可启停 Skill | `SkillsPanel.tsx`、Skill IPC | `skill-service.test.ts` | 如何保证运行期间配置不变？ |

## 当前未验证事项

按照项目约定，本阶段没有运行测试、类型检查、lint、构建、打包、浏览器自动化或真实模型请求。因此只能说明源码已接入，不能宣称编译或运行通过。
