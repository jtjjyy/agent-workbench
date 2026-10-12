import type { SkillDefinition } from '../../shared/skills';

export const BUILTIN_SKILLS: SkillDefinition[] = [
  { id: 'repository-understanding', name: '代码仓库理解', source: 'builtin',
    description: '帮助建立代码仓库结构、入口、依赖和风险的证据化理解。',
    keywords: ['代码', '仓库', '项目', '架构', '源码', '理解', '入口', '依赖'],
    allowedTools: ['list_files', 'read_file', 'search_text', 'search_knowledge', 'read_project_knowledge'],
    instructions: '先说明目标和已知范围，再使用可用的文件或知识工具建立证据。优先寻找 README、配置、入口和关键模块；引用相对路径与行号。区分已确认事实、合理推断和待确认问题，不把未读取的文件说成已检查。' },
  { id: 'technical-research', name: '技术资料调研', source: 'builtin',
    description: '帮助围绕技术问题组织资料、证据、比较和结论。',
    keywords: ['调研', '资料', '文档', '技术', '比较', '方案', '原理', '资料库'],
    allowedTools: ['search_knowledge', 'read_project_knowledge', 'read_file', 'search_text'],
    instructions: '先拆分问题和判断标准，再检索已有项目知识。对每个结论标注来源或明确说明缺少证据；区分资料原文、事实总结、建议和假设。不要因为资料片段看起来合理就扩大结论。' },
  { id: 'change-verification', name: '变更验证与复盘', source: 'builtin',
    description: '帮助在修改代码前后制定验证范围、风险和复盘记录。',
    keywords: ['修改', '变更', '修复', '验证', '测试', '回归', '故障', '复盘'],
    allowedTools: ['read_file', 'search_text', 'search_knowledge', 'read_project_knowledge', 'replace_text'],
    instructions: '在提出修改前说明影响范围、前置证据和验证计划。修改必须遵守现有审批流程；不得把审批视为沙箱或回滚保证。完成后区分已执行、未执行和建议执行的验证，记录残余风险，不编造测试结果。' },
];
