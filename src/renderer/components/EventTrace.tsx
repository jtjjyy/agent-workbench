import { Activity } from 'lucide-react';
import type { EventEnvelope } from '../../shared/contracts';
import { EVENT_LABELS, UI_LOCALE } from '../../shared/zh-CN';

export function EventTrace({ events }: { events: EventEnvelope[] }) {
  return (
    <section className="event-trace" aria-label="事件轨迹">
      <header className="section-header">
        <h2><Activity size={15} aria-hidden="true" />事件轨迹</h2>
        <span className="event-count" aria-label={`${events.length} 条事件`}>{events.length}</span>
      </header>
      <div className="trace-columns" aria-hidden="true">
        <span>序号</span><span>时间</span><span>事件</span>
      </div>
      <ol className="trace-list">
        {events.map((event) => (
          <li className={event.type === 'run.failed' ? 'trace-row trace-failed' : 'trace-row'}
            key={event.sequence}>
            <span className="trace-sequence">{event.sequence}</span>
            <time dateTime={event.occurredAt}>
              {new Date(event.occurredAt).toLocaleTimeString(UI_LOCALE, { hour12: false })}
            </time>
            <span className="trace-type">{event.type === 'tool.completed' && event.payload.isError
              ? '工具执行失败' : EVENT_LABELS[event.type] || '未知事件'}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
