import { BookMarked, Check, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AgentBridge } from '../../shared/contracts';
import type { SkillSummary } from '../../shared/skills';

export function SkillsPanel({ bridge, blocked }: { bridge?: AgentBridge; blocked: boolean }) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    void (async () => {
      try {
        if (!bridge) throw new Error();
        const result = await bridge.readSkills();
        if (!disposed) setSkills(result);
      } catch { if (!disposed) setError('无法读取 Skills 列表。'); }
      finally { if (!disposed) setLoading(false); }
    })();
    return () => { disposed = true; };
  }, [bridge]);

  async function toggle(skill: SkillSummary) {
    if (!bridge || blocked || busyId) return;
    setBusyId(skill.id); setError(null);
    try { setSkills(await bridge.setSkillEnabled({ id: skill.id, enabled: !skill.enabled })); }
    catch { setError('当前任务进行中，暂时不能修改 Skill。'); }
    finally { setBusyId(null); }
  }

  return <section className="skills-panel" aria-label="Skills 管理">
    <header className="section-header"><h2><BookMarked size={15} aria-hidden="true" />Skills</h2><span className="event-count">{skills.filter((skill) => skill.enabled).length}</span></header>
    <div className="skills-content">
      {loading ? <p className="skills-empty"><LoaderCircle size={14} aria-hidden="true" />正在读取 Skills</p> : skills.length === 0 ? <p className="skills-empty">暂无可用 Skill</p> : <ul className="skills-list">{skills.map((skill) => <li key={skill.id} className="skill-item"><div className="skill-copy"><strong>{skill.name}</strong><p>{skill.description}</p><small>{skill.source === 'builtin' ? '内置 Skill' : '本地 Skill'} · 关键词：{skill.keywords.join('、')}</small></div><button className={`skill-toggle${skill.enabled ? ' is-enabled' : ''}`} type="button" aria-pressed={skill.enabled} aria-label={`${skill.name}${skill.enabled ? '已启用' : '已停用'}`} title={skill.enabled ? '停用 Skill' : '启用 Skill'} disabled={!bridge || blocked || busyId !== null} onClick={() => { void toggle(skill); }}>{skill.enabled && <Check size={14} aria-hidden="true" />}<span>{skill.enabled ? '已启用' : '已停用'}</span></button></li>)}</ul>}
      {error && <p className="skills-error" role="alert">{error}</p>}
      <p className="skills-notice">Skill 只提供任务方法，不会新增工具权限，也不能绕过审批。</p>
    </div>
  </section>;
}
