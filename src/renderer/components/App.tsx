import { Bot, CircleAlert, RotateCcw, User } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_CONVERSATION_ID, type EventEnvelope, type SubmitMessageRequest } from '../../shared/contracts';
import { conversationReducer, createConversationState } from '../state/conversation-reducer';
import { Composer } from './Composer';
import { EventTrace } from './EventTrace';

export function App() {
  const [state, setState] = useState(createConversationState);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const pendingRequest = useRef<SubmitMessageRequest | null>(null);
  const mounted = useRef(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followsTail = useRef(true);
  const bridge = window.agent;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let disposed = false;
    let phase: 'loading' | 'live' | 'failed' = 'loading';
    let unsubscribe: (() => void) | undefined;
    const buffered: EventEnvelope[] = [];
    setLoading(true);
    setHistoryError(null);

    async function restore() {
      if (!bridge) {
        setHistoryError('Desktop connection unavailable.');
        setLoading(false);
        return;
      }
      try {
        // Subscribe first: history may overlap events delivered during the read.
        unsubscribe = bridge.onEvent((event) => {
          if (disposed || phase === 'failed') return;
          if (phase === 'loading') buffered.push(event);
          else setState((previous) => conversationReducer(previous, event));
        });
        const history = await bridge.readConversation(DEFAULT_CONVERSATION_ID);
        if (disposed) return;
        const ordered = [...history, ...buffered].sort((a, b) => a.sequence - b.sequence);
        const restored = ordered.reduce(conversationReducer, createConversationState());
        buffered.length = 0;
        phase = 'live';
        setState(restored);
        setLoading(false);
      } catch {
        if (disposed) return;
        phase = 'failed';
        buffered.length = 0;
        setHistoryError('Could not load conversation.');
        setLoading(false);
      }
    }
    void restore();
    return () => {
      disposed = true;
      buffered.length = 0;
      unsubscribe?.();
    };
  }, [bridge, reload]);

  useEffect(() => {
    if (transcriptRef.current && followsTail.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [state.messages]);

  const disabled = !bridge || loading || !!historyError || state.reloadRequired
    || !!state.activeRunId || pending;
  const error = historyError || submitError || state.error;
  const status = !bridge ? 'Offline' : loading ? 'Loading'
    : historyError ? 'Unavailable' : state.reloadRequired ? 'Reload required'
      : state.activeRunId ? 'Running' : pending ? 'Sending' : 'Ready';

  async function submit() {
    if (!bridge || disabled || pendingRequest.current || !text.trim()) return;
    const request: SubmitMessageRequest = {
      conversationId: DEFAULT_CONVERSATION_ID,
      clientRequestId: crypto.randomUUID(),
      text: text.trim(),
    };
    pendingRequest.current = request;
    setPending(true);
    setSubmitError(null);
    try {
      await bridge.submitMessage(request);
      if (mounted.current) setText('');
    } catch {
      if (mounted.current) setSubmitError('Could not send message.');
    } finally {
      pendingRequest.current = null;
      if (mounted.current) setPending(false);
    }
  }

  return (
    <main className="workbench">
      <header className="workbench-header">
        <h1>Agent Workbench</h1>
        <span className="provider-label">Mock</span>
        <span role="status" className={`connection-status${status === 'Running' ? ' is-running' : ''}`}>
          <span className="status-marker" aria-hidden="true" />{status}
        </span>
      </header>
      <div className="workbench-body">
        <section className="conversation" aria-label="Conversation">
          <header className="section-header"><h2>Conversation</h2></header>
          <div className="transcript" ref={transcriptRef} tabIndex={0} onScroll={(event) => {
            const transcript = event.currentTarget;
            followsTail.current = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
          }}>
            {state.messages.map((message) => (
              <article className={`message message-${message.role}`} key={message.messageId}
                aria-label={`${message.role === 'user' ? 'You' : 'Agent'} message`}>
                <header className="message-header">
                  {message.role === 'user'
                    ? <User size={15} aria-hidden="true" />
                    : <Bot size={15} aria-hidden="true" />}
                  <span>{message.role === 'user' ? 'You' : 'Agent'}</span>
                  {message.status === 'streaming' && <span className="message-status">Streaming</span>}
                  {message.status === 'failed' && <span className="message-failed">Failed</span>}
                </header>
                <p className="message-text">{message.text}</p>
              </article>
            ))}
          </div>
          {error && (
            <div className="error-row">
              <CircleAlert size={16} aria-hidden="true" />
              <p role="alert">{error}</p>
              {bridge && (historyError || state.reloadRequired) && (
                <button className="icon-button" type="button" aria-label="Reload conversation"
                  title="Reload conversation" disabled={pending || loading}
                  onClick={() => { setSubmitError(null); setReload((value) => value + 1); }}>
                  <RotateCcw size={16} aria-hidden="true" />
                </button>
              )}
            </div>
          )}
          <Composer text={text} disabled={disabled} onChange={setText} onSubmit={() => { void submit(); }} />
        </section>
        <EventTrace events={state.events} />
      </div>
    </main>
  );
}
