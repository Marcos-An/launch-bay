import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { HermesMessage, HermesToolCall } from '../types';

function AssistantCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== undefined) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  async function handleCopy() {
    const clipboard = window.navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') return;
    try {
      await clipboard.writeText(text);
      setCopied(true);
      if (timeoutRef.current !== undefined) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Stay silent per UX guidance — keep label as Copy.
    }
  }

  return (
    <button
      type="button"
      className="message-copy"
      aria-label="Copy message"
      onClick={handleCopy}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function statusLabel(status: HermesToolCall['status']) {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'in_progress') return 'running';
  return 'pending';
}

function DiffPreview({ diff }: { diff: { path: string; oldText?: string; newText: string } }) {
  const oldLines = diff.oldText ? diff.oldText.split('\n') : [];
  const newLines = diff.newText.split('\n');
  return (
    <div className="diff-preview">
      <div className="diff-preview-head">{diff.path}</div>
      <pre className="diff-preview-body">
        {oldLines.map((line, idx) => (
          <span key={`o-${idx}`} className="diff-line diff-line-removed">{`- ${line}\n`}</span>
        ))}
        {newLines.map((line, idx) => (
          <span key={`n-${idx}`} className="diff-line diff-line-added">{`+ ${line}\n`}</span>
        ))}
      </pre>
    </div>
  );
}

function ToolCallCard({ tool }: { tool: HermesToolCall }) {
  const subtitle = tool.locations?.[0]?.path;
  return (
    <div className={`tool-call tool-call-${tool.status}`} aria-label={`Tool ${tool.title} — ${statusLabel(tool.status)}`}>
      <div className="tool-call-row">
        <span className="tool-call-status" data-status={tool.status} />
        <span className="tool-call-title">{tool.title}</span>
        {tool.kind ? <span className="tool-call-kind">{tool.kind}</span> : null}
        <span className="tool-call-state">{statusLabel(tool.status)}</span>
      </div>
      {subtitle ? <div className="tool-call-subtitle">{subtitle}</div> : null}
      {tool.diffs?.map((diff, idx) => (
        <DiffPreview key={`${diff.path}-${idx}`} diff={diff} />
      ))}
    </div>
  );
}

export function ChatMessage({ message, streaming = false }: { message: HermesMessage; streaming?: boolean }) {
  if (message.role === 'user') {
    const images = message.images ?? [];
    const resources = message.resources ?? [];
    return (
      <div className="message-row message-row-user">
        <div className="message message-user">
          {images.length > 0 ? (
            <div className="message-attachments">
              {images.map((image, idx) => (
                <img
                  key={image.id ?? image.name ?? `${idx}`}
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={image.name ?? 'Attached image'}
                />
              ))}
            </div>
          ) : null}
          {resources.length > 0 ? (
            <div className="message-resources">
              {resources.map((resource, idx) => {
                const isBlob = typeof resource.blob === 'string';
                return (
                  <div className="message-resource" key={resource.id ?? `${idx}`}>
                    <span className="message-resource-icon" aria-hidden="true">{isBlob ? 'PDF' : 'TXT'}</span>
                    <span className="message-resource-name">
                      {resource.name ?? resource.uri.split('/').pop() ?? 'file'}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}
          {message.text ? <div className="message-text">{message.text}</div> : null}
        </div>
      </div>
    );
  }

  const toolCalls = message.toolCalls ?? [];
  const hasText = message.text.length > 0;

  return (
    <article className="assistant-turn">
      <div className="assistant-body">
        {toolCalls.length > 0 ? (
          <div className="tool-calls">
            {toolCalls.map((tool) => (
              <ToolCallCard key={tool.id} tool={tool} />
            ))}
          </div>
        ) : null}
        {hasText ? (
          <div className="markdown-body">
            <ReactMarkdown>{message.text}</ReactMarkdown>
            {streaming ? <span className="streaming-cursor" aria-hidden="true" /> : null}
          </div>
        ) : streaming ? (
          <span className="streaming-cursor" aria-hidden="true" />
        ) : null}
        {!streaming && hasText ? <AssistantCopyButton text={message.text} /> : null}
      </div>
    </article>
  );
}
