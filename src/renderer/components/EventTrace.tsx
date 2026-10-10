import { Activity } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { EventEnvelope } from '../../shared/contracts';

export function EventTrace({ events }: { events: EventEnvelope[] }) {
  const listRef = useRef<HTMLOListElement>(null);
  const followsTail = useRef(true);

  useEffect(() => {
    if (listRef.current && followsTail.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [events]);

  return (
    <section className="event-trace" aria-label="Event trace">
      <header className="section-header">
        <h2><Activity size={15} aria-hidden="true" />Event trace</h2>
        <span className="event-count">{events.length}</span>
      </header>
      <div className="trace-columns" aria-hidden="true">
        <span>Seq</span><span>Time</span><span>Event</span>
      </div>
      <ol className="trace-list" ref={listRef} onScroll={(event) => {
        const list = event.currentTarget;
        followsTail.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
      }}>
        {events.map((event) => (
          <li className={event.type === 'run.failed' ? 'trace-row trace-failed' : 'trace-row'}
            key={event.sequence}>
            <span className="trace-sequence">{event.sequence}</span>
            <time dateTime={event.occurredAt}>
              {new Date(event.occurredAt).toLocaleTimeString([], { hour12: false })}
            </time>
            <span className="trace-type">{event.type}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
