import { useEffect } from 'react';
import type { AgentCliTool } from '../types';

type NewSessionModalProps = {
  projectName: string;
  toolOptions: AgentCliTool[];
  kind: string;
  name: string;
  command: string;
  onKindChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onCommandChange: (value: string) => void;
  onCancel: () => void;
  onCreate: () => void;
};

export function NewSessionModal({
  projectName,
  toolOptions,
  kind,
  name,
  command,
  onKindChange,
  onNameChange,
  onCommandChange,
  onCancel,
  onCreate
}: NewSessionModalProps) {
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
      <section className="session-modal" role="dialog" aria-modal="true" aria-label="New session">
        <div className="session-modal-head">
          <div>
            <div className="context">{projectName}</div>
            <h2>New session</h2>
          </div>
          <button className="terminal-action" type="button" onClick={onCancel} aria-label="Close new session dialog">Close</button>
        </div>
        <label className="field-label">
          <span>Session type</span>
          <select value={kind} onChange={(event) => onKindChange(event.target.value)}>
            {toolOptions.map((tool) => (
              <option value={tool.id} key={tool.id}>{tool.label}</option>
            ))}
          </select>
        </label>
        <label className="field-label">
          <span>Session name</span>
          <input value={name} onChange={(event) => onNameChange(event.target.value)} />
        </label>
        <label className="field-label">
          <span>Command</span>
          <input value={command} onChange={(event) => onCommandChange(event.target.value)} />
        </label>
        <div className="session-modal-actions">
          <button className="secondary" type="button" onClick={onCancel}>Cancel</button>
          <button className="primary" type="button" onClick={onCreate}>Create session</button>
        </div>
      </section>
    </div>
  );
}
