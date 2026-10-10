import { Send } from 'lucide-react';
import { MAX_SUBMIT_TEXT_LENGTH } from '../../shared/contracts';

interface ComposerProps {
  text: string;
  disabled: boolean;
  onChange: (text: string) => void;
  onSubmit: () => void;
}

export function Composer({ text, disabled, onChange, onSubmit }: ComposerProps) {
  const canSubmit = !disabled && text.trim().length > 0;
  return (
    <form className="composer" onSubmit={(event) => {
      event.preventDefault();
      if (canSubmit) onSubmit();
    }}>
      <textarea
        aria-label="Message"
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
      <button
        className="icon-button send-button"
        type="submit"
        aria-label="Send message"
        title="Send message"
        disabled={!canSubmit}
      >
        <Send size={18} aria-hidden="true" />
      </button>
    </form>
  );
}
