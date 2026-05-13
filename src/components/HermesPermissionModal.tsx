import { useEffect } from 'react';
import type { HermesPermissionRequest } from '../types';

type HermesPermissionModalProps = {
  request: HermesPermissionRequest;
  onRespond: (optionId: string | null) => void;
};

function isAllow(kind: HermesPermissionRequest['options'][number]['kind']) {
  return kind === 'allow_once' || kind === 'allow_always';
}

function prettyArgs(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

export function HermesPermissionModal({ request, onRespond }: HermesPermissionModalProps) {
  useEffect(() => {
    function handleEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      onRespond(null);
    }
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onRespond]);

  const args = prettyArgs(request.toolRawInput);

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="session-modal hermes-permission-modal" role="dialog" aria-modal="true" aria-label="Hermes tool approval">
        <div className="session-modal-head">
          <div>
            <h2>Hermes needs permission</h2>
            {request.toolTitle ? (
              <div className="hermes-permission-subtitle">
                {request.toolKind ? <span className="tool-call-kind">{request.toolKind}</span> : null}
                {request.toolTitle}
              </div>
            ) : null}
          </div>
          <button className="terminal-action" type="button" onClick={() => onRespond(null)} aria-label="Dismiss permission request">Close</button>
        </div>

        {request.toolLocations && request.toolLocations.length > 0 ? (
          <div className="hermes-permission-locations">
            {request.toolLocations.map((loc, idx) => (
              <code key={`${loc.path}-${idx}`}>{loc.path}{loc.line ? `:${loc.line}` : ''}</code>
            ))}
          </div>
        ) : null}

        {args ? (
          <details className="hermes-permission-args">
            <summary>Arguments</summary>
            <pre>{args}</pre>
          </details>
        ) : null}

        {request.toolDiffs?.map((diff, idx) => {
          const oldLines = diff.oldText ? diff.oldText.split('\n') : [];
          const newLines = diff.newText.split('\n');
          return (
            <div className="diff-preview" key={`${diff.path}-${idx}`}>
              <div className="diff-preview-head">{diff.path}</div>
              <pre className="diff-preview-body">
                {oldLines.map((line, i) => (
                  <span key={`o-${i}`} className="diff-line diff-line-removed">{`- ${line}\n`}</span>
                ))}
                {newLines.map((line, i) => (
                  <span key={`n-${i}`} className="diff-line diff-line-added">{`+ ${line}\n`}</span>
                ))}
              </pre>
            </div>
          );
        })}

        <p className="confirm-copy">
          Hermes is in manual-approval mode. Choose how to handle this tool call.
        </p>
        <div className="hermes-permission-options">
          {request.options.map((option) => (
            <button
              key={option.optionId}
              type="button"
              className={isAllow(option.kind) ? 'primary' : 'secondary'}
              onClick={() => onRespond(option.optionId)}
            >
              {option.name}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
