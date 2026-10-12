import { Send, Square } from 'lucide-react';
import { MAX_SUBMIT_TEXT_LENGTH } from '../../shared/contracts';

interface ComposerProps {
  text: string;
  disabled: boolean;
  onChange: (text: string) => void;
  onSubmit: () => void;
  activeRunId: string | null;
  cancelling: boolean;
  canCancel: boolean;
  onCancel: (runId: string) => void;
}

export function Composer({ text, disabled, onChange, onSubmit, activeRunId, cancelling, canCancel, onCancel }: ComposerProps) {
  const canSubmit = !disabled && text.trim().length > 0;
  return (
    <form className="composer" onSubmit={(event) => {
      event.preventDefault();
      if (canSubmit) onSubmit();
    }}>
      <textarea
        aria-label="消息"
        rows={2}
        value={text}
        disabled={disabled}
        maxLength={MAX_SUBMIT_TEXT_LENGTH}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (canSubmit) onSubmit();
          }
        }}
      />
      {activeRunId ? <button
        className="icon-button cancel-button"
        type="button"
        aria-label={cancelling ? '取消中' : '取消任务'}
        title={cancelling ? '取消中' : '取消任务'}
        disabled={!canCancel || cancelling}
        onClick={() => onCancel(activeRunId)}
      >
        <Square size={17} aria-hidden="true" />
      </button> : <button
        className="icon-button send-button"
        type="submit"
        aria-label="发送消息"
        title="发送消息"
        disabled={!canSubmit}
      >
        <Send size={18} aria-hidden="true" />
      </button>}
    </form>
  );
}
