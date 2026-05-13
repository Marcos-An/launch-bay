import { useEffect, useState } from 'react';
import type { HermesSessionInfo } from '../types';

type PastSessionsModalProps = {
  projectName: string;
  cwd: string;
  load: () => Promise<HermesSessionInfo[]>;
  onCancel: () => void;
  onSelect: (sessionId: string) => void;
};

export function PastSessionsModal({ projectName, cwd, load, onCancel, onSelect }: PastSessionsModalProps) {
  const [sessions, setSessions] = useState<HermesSessionInfo[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((items) => {
        if (!cancelled) setSessions(items);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    function handleEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      onCancel();
    }
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="session-modal past-sessions-modal" role="dialog" aria-modal="true" aria-label="Past Hermes sessions">
        <div className="session-modal-head">
          <div>
            <div className="context">{projectName}</div>
            <h2>Past sessions</h2>
            <div className="past-sessions-subtitle">in {cwd}</div>
          </div>
          <button className="terminal-action" type="button" onClick={onCancel} aria-label="Close past sessions">Close</button>
        </div>
        {error ? <p className="confirm-copy" role="alert">{error}</p> : null}
        {sessions === undefined && !error ? <p className="confirm-copy">Loading…</p> : null}
        {sessions !== undefined && sessions.length === 0 ? (
          <div className="past-sessions-empty">
            <p className="confirm-copy">No past sessions for this project yet.</p>
            <p className="past-sessions-hint">
              A session shows up here after its first message. Conversations started in <code>hermes chat</code>,
              the gateway, or cron aren't listed — only ACP clients (Launch Bay, Zed, VS Code).
            </p>
          </div>
        ) : null}
        {sessions && sessions.length > 0 ? (
          <ul className="past-sessions-list">
            {sessions.map((session) => (
              <li key={session.sessionId}>
                <button type="button" className="past-session-item" onClick={() => onSelect(session.sessionId)}>
                  <span className="past-session-title">{session.title ?? session.sessionId}</span>
                  {session.updatedAt ? (
                    <span className="past-session-stamp">{session.updatedAt}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
