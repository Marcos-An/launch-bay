import ReactMarkdown from 'react-markdown';
import type { HermesInstanceSnapshot } from '../types';

type AgentSession = HermesInstanceSnapshot & {
  kind: string;
  name: string;
  command: string;
  draft: string;
};

type AgentSessionViewProps = {
  projectName: string;
  session: AgentSession;
  toolLabel: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onReset: () => void;
  onClose: () => void;
};

export function AgentSessionView({
  projectName,
  session,
  toolLabel,
  onDraftChange,
  onSend,
  onReset,
  onClose
}: AgentSessionViewProps) {
  return (
    <section className="agent-session-view" aria-label={session.name}>
      <div className="agent-session-head">
        <div>
          <div className="context">{projectName} session</div>
          <h1>{session.name}</h1>
          <p>{toolLabel}</p>
        </div>
        <div className="server-actions">
          <button className="secondary" type="button" onClick={onReset}>Reset</button>
          <button className="secondary" type="button" onClick={onClose}>Close</button>
        </div>
      </div>
      <div className="runtime-grid agent-session-details">
        <div className="runtime-cell">
          <div className="runtime-label">Type</div>
          <div className="runtime-value">{toolLabel}</div>
        </div>
        <div className="runtime-cell">
          <div className="runtime-label">Command</div>
          <div className="runtime-value">{session.command}</div>
        </div>
      </div>
      {session.kind === 'hermes' ? (
        <>
          <div className="embedded-transcript agent-session-transcript" aria-label={`${session.name} transcript`}>
            {session.snapshot.messages.length === 0 ? (
              <div className="embedded-empty">New {session.name} session for {projectName}</div>
            ) : session.snapshot.messages.map((message) => (
              <div className={`embedded-message embedded-message-${message.role}`} key={message.id}>
                <div className="embedded-message-role">{message.role === 'user' ? 'You' : session.name}</div>
                {message.role === 'assistant' ? (
                  <div className="markdown-body"><ReactMarkdown>{message.text}</ReactMarkdown></div>
                ) : (
                  <div>{message.text}</div>
                )}
              </div>
            ))}
            {session.snapshot.pending ? <div role="status" className="embedded-empty">{session.name} is working…</div> : null}
            {session.snapshot.error ? <div role="alert" className="embedded-error">{session.snapshot.error}</div> : null}
          </div>
          <div className="embedded-input-row agent-session-input-row">
            <textarea
              aria-label={`Message ${session.name}`}
              className="embedded-input embedded-hermes-input"
              rows={1}
              value={session.draft}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                onSend();
              }}
              placeholder={`Message ${session.name}`}
            />
            <button className="terminal-action" type="button" onClick={onSend} disabled={session.snapshot.pending}>Send</button>
          </div>
        </>
      ) : (
        <div className="agent-session-placeholder">
          <div className="runtime-label">Configured command</div>
          <div className="runtime-value">{session.command}</div>
          <p>Runner integration for {toolLabel} sessions can be wired next.</p>
        </div>
      )}
    </section>
  );
}
