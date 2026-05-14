import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type RefObject
} from 'react';
import type {
  HermesAvailableCommand,
  HermesImageAttachment,
  HermesResourceAttachment,
  HermesSnapshot
} from '../types';
import { ChatMessage } from './ChatMessage';

const COMPOSER_INPUT_MAX_HEIGHT = 180;
const COMPOSER_ATTACHMENT_LIMIT_BYTES = 10 * 1024 * 1024;
const TEXT_LIKE_MIME_PREFIXES = ['text/'];
const TEXT_LIKE_MIME_EXACT = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/yaml',
  'application/toml',
  'application/sql',
  'application/x-sh',
  'application/x-yaml'
]);

function isTextLikeMime(mime: string): boolean {
  if (!mime) return false;
  if (TEXT_LIKE_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) return true;
  return TEXT_LIKE_MIME_EXACT.has(mime);
}

function makeAttachmentId() {
  return `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resizeComposerInput(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return;
  textarea.style.height = 'auto';
  const nextHeight = Math.min(textarea.scrollHeight, COMPOSER_INPUT_MAX_HEIGHT);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > COMPOSER_INPUT_MAX_HEIGHT ? 'auto' : 'hidden';
}

async function bytesToBase64(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
}

export type DroppedAttachment =
  | { kind: 'image'; image: HermesImageAttachment }
  | { kind: 'resource'; resource: HermesResourceAttachment };

async function fileToAttachment(file: File): Promise<DroppedAttachment | undefined> {
  if (file.size > COMPOSER_ATTACHMENT_LIMIT_BYTES) return undefined;
  if (file.type.startsWith('image/')) {
    const data = await bytesToBase64(await file.arrayBuffer());
    return {
      kind: 'image',
      image: {
        id: makeAttachmentId(),
        data,
        mimeType: file.type,
        name: file.name || undefined
      }
    };
  }
  if (isTextLikeMime(file.type) || /\.(md|markdown|txt|json|ya?ml|toml|csv|tsv|log|xml|html?|css|s?css|js|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|sql|gql|graphql|proto|gitignore|gitattributes|dockerfile|rst|tex)$/i.test(file.name)) {
    const text = await file.text();
    return {
      kind: 'resource',
      resource: {
        id: makeAttachmentId(),
        uri: `attachment://${file.name || 'pasted-text'}`,
        mimeType: file.type || 'text/plain',
        name: file.name || undefined,
        text,
        sizeBytes: file.size
      }
    };
  }
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    const blob = await bytesToBase64(await file.arrayBuffer());
    return {
      kind: 'resource',
      resource: {
        id: makeAttachmentId(),
        uri: `attachment://${file.name || 'document.pdf'}`,
        mimeType: 'application/pdf',
        name: file.name || undefined,
        blob,
        sizeBytes: file.size
      }
    };
  }
  return undefined;
}

type HermesChatViewProps = {
  projectName: string;
  projectSuggestions: string[];
  sessionName: string;
  sessionPrompt: string;
  snapshot: HermesSnapshot;
  isThinking: boolean;
  elapsedLabel: string;
  contextUsageLabel: string;
  hasHermesBridge: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onReset: () => void;
  composerInputRef: RefObject<HTMLTextAreaElement>;
  transcriptRef: RefObject<HTMLDivElement>;
  attachments?: HermesImageAttachment[];
  resources?: HermesResourceAttachment[];
  onAddAttachments?: (items: HermesImageAttachment[]) => void;
  onAddResources?: (items: HermesResourceAttachment[]) => void;
  onRemoveAttachment?: (id: string) => void;
  onRemoveResource?: (id: string) => void;
  onPickAttachment?: () => Promise<DroppedAttachment | undefined>;
  onCancel?: () => void;
  onOpenHistory?: () => void;
  approvalMode?: 'auto' | 'manual';
  onApprovalModeChange?: (mode: 'auto' | 'manual') => void;
  projectFiles?: string[];
  onMentionFile?: (relativePath: string) => Promise<HermesResourceAttachment | undefined>;
  /** Skills offered by the agent of this session (Hermes/Claude). */
  skills?: { name: string; description: string }[];
};

export function HermesChatView({
  projectName,
  projectSuggestions,
  sessionName,
  sessionPrompt,
  snapshot,
  isThinking,
  elapsedLabel,
  contextUsageLabel,
  hasHermesBridge,
  draft,
  onDraftChange,
  onSend,
  onReset,
  composerInputRef,
  transcriptRef,
  attachments = [],
  resources = [],
  onAddAttachments,
  onAddResources,
  onRemoveAttachment,
  onRemoveResource,
  onPickAttachment,
  onCancel,
  onOpenHistory,
  approvalMode,
  onApprovalModeChange,
  projectFiles = [],
  onMentionFile,
  skills = []
}: HermesChatViewProps) {
  const attachInputId = useId();
  const dragCounterRef = useRef(0);
  const [slashHighlight, setSlashHighlight] = useState(0);
  useEffect(() => {
    resizeComposerInput(composerInputRef.current);
  }, [draft, composerInputRef]);

  type SlashSuggestion = HermesAvailableCommand & { source: 'command' | 'skill' };
  const availableCommands = snapshot.availableCommands ?? [];
  const slashQuery = draft.startsWith('/') && !draft.includes(' ') ? draft.slice(1).toLowerCase() : undefined;
  const slashSuggestions = useMemo<SlashSuggestion[]>(() => {
    if (slashQuery === undefined) return [];
    const commands: SlashSuggestion[] = availableCommands.map((cmd) => ({ ...cmd, source: 'command' }));
    const skillSuggestions: SlashSuggestion[] = skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: 'skill'
    }));
    const seen = new Set<string>();
    const merged = [...commands, ...skillSuggestions].filter((cmd) => {
      const key = cmd.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return merged.filter((cmd) => cmd.name.toLowerCase().includes(slashQuery)).slice(0, 12);
  }, [slashQuery, availableCommands, skills]);

  useEffect(() => {
    if (slashHighlight >= slashSuggestions.length) setSlashHighlight(0);
  }, [slashSuggestions.length, slashHighlight]);

  function applySlashSuggestion(command: SlashSuggestion) {
    onDraftChange(`/${command.name} `);
    composerInputRef.current?.focus();
  }

  const [mentionHighlight, setMentionHighlight] = useState(0);
  // Capture the trailing @ token (no whitespace) so users can keep typing
  // around it without dismissing the picker.
  const mentionMatch = draft.match(/(^|\s)@([^\s@]*)$/);
  const mentionQuery = mentionMatch ? mentionMatch[2].toLowerCase() : undefined;
  const mentionSuggestions = useMemo(() => {
    if (mentionQuery === undefined || !onMentionFile) return [] as string[];
    const lower = mentionQuery;
    return projectFiles
      .filter((file) => file.toLowerCase().includes(lower))
      .slice(0, 8);
  }, [mentionQuery, projectFiles, onMentionFile]);

  useEffect(() => {
    if (mentionHighlight >= mentionSuggestions.length) setMentionHighlight(0);
  }, [mentionSuggestions.length, mentionHighlight]);

  async function applyMentionSuggestion(relativePath: string) {
    if (!onMentionFile || !mentionMatch) return;
    const attachment = await onMentionFile(relativePath);
    if (!attachment) return;
    onAddResources?.([{ ...attachment, id: attachment.id ?? makeAttachmentId() }]);
    // Strip the `@token` from the draft so the visible composer stays clean.
    const start = mentionMatch.index ?? 0;
    const prefix = draft.slice(0, start + mentionMatch[1].length);
    const next = `${prefix}`;
    onDraftChange(next);
    composerInputRef.current?.focus();
  }

  function distribute(results: DroppedAttachment[]) {
    const images: HermesImageAttachment[] = [];
    const res: HermesResourceAttachment[] = [];
    for (const item of results) {
      if (item.kind === 'image') images.push(item.image);
      else res.push(item.resource);
    }
    if (images.length > 0) onAddAttachments?.(images);
    if (res.length > 0) onAddResources?.(res);
  }

  async function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!onAddAttachments && !onAddResources) return;
    const items = event.clipboardData?.items;
    if (!items || items.length === 0) return;
    const files: File[] = [];
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (files.length === 0) return;
    event.preventDefault();
    const built = await Promise.all(files.map((file) => fileToAttachment(file)));
    const valid = built.filter((item): item is DroppedAttachment => Boolean(item));
    if (valid.length > 0) distribute(valid);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (slashSuggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSlashHighlight((current) => (current + 1) % slashSuggestions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSlashHighlight((current) => (current - 1 + slashSuggestions.length) % slashSuggestions.length);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing)) {
        event.preventDefault();
        const choice = slashSuggestions[slashHighlight] ?? slashSuggestions[0];
        if (choice) applySlashSuggestion(choice);
        return;
      }
    }
    if (mentionSuggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionHighlight((current) => (current + 1) % mentionSuggestions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionHighlight((current) => (current - 1 + mentionSuggestions.length) % mentionSuggestions.length);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing)) {
        event.preventDefault();
        const choice = mentionSuggestions[mentionHighlight] ?? mentionSuggestions[0];
        if (choice) void applyMentionSuggestion(choice);
        return;
      }
    }
    if (event.key === 'Escape' && !event.nativeEvent.isComposing && draft.length > 0) {
      event.preventDefault();
      onDraftChange('');
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onSend();
  }

  async function handlePickAttachment() {
    if (!onPickAttachment) return;
    const picked = await onPickAttachment();
    if (!picked) return;
    distribute([picked]);
  }

  async function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!onAddAttachments && !onAddResources) return;
    event.preventDefault();
    dragCounterRef.current = 0;
    event.currentTarget.classList.remove('composer-wrap-dragging');
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    const built = await Promise.all(files.map((file) => fileToAttachment(file)));
    const valid = built.filter((item): item is DroppedAttachment => Boolean(item));
    if (valid.length > 0) distribute(valid);
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!onAddAttachments && !onAddResources) return;
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    dragCounterRef.current += 1;
    event.currentTarget.classList.add('composer-wrap-dragging');
  }
  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) {
      event.currentTarget.classList.remove('composer-wrap-dragging');
    }
  }
  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!onAddAttachments && !onAddResources) return;
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
  }

  const sendDisabled = !hasHermesBridge || isThinking;
  const canAttach = Boolean(onPickAttachment && hasHermesBridge);

  return (
    <section className="chat-view" aria-label={`${projectName} ${sessionName}`}>
      {(() => {
        const visibleMessages = snapshot.messages.filter(
          (message) =>
            message.role === 'user' ||
            message.text.length > 0 ||
            (message.toolCalls?.length ?? 0) > 0 ||
            (message.images?.length ?? 0) > 0
        );
        const lastVisible = visibleMessages[visibleMessages.length - 1];
        const tailIsStreamingAssistant = isThinking && lastVisible?.role === 'assistant';
        const showThinkingBlock = isThinking && !tailIsStreamingAssistant;

        if (visibleMessages.length === 0 && !isThinking) {
          return (
            <div className="chat-empty">
              <div className="chat-inner">
                <div className="context">{projectName} context</div>
                <h1>What do you want to work on?</h1>
                <div className="suggestions">
                  {projectSuggestions.map((suggestion) => (
                    <div className="suggestion" key={suggestion}>{suggestion}</div>
                  ))}
                </div>
              </div>
            </div>
          );
        }

        const plan = snapshot.plan ?? [];
        return (
          <div className="chat-messages" ref={transcriptRef}>
            {plan.length > 0 ? (
              <aside className="hermes-plan" aria-label="Hermes plan">
                <div className="hermes-plan-head">Plan</div>
                <ol>
                  {plan.map((entry, idx) => (
                    <li key={`${idx}-${entry.content.slice(0, 24)}`} data-status={entry.status ?? 'pending'}>
                      <span className="hermes-plan-marker" aria-hidden="true" />
                      <span className="hermes-plan-text">{entry.content}</span>
                      {entry.priority ? <span className="hermes-plan-priority">{entry.priority}</span> : null}
                    </li>
                  ))}
                </ol>
              </aside>
            ) : null}
            {visibleMessages.map((message) => (
              <ChatMessage
                key={message.id}
                message={message}
                streaming={tailIsStreamingAssistant && message.id === lastVisible?.id}
              />
            ))}
            {showThinkingBlock ? (
              <div className="assistant-turn assistant-turn-pending" role="status" aria-live="polite">
                <div className="assistant-body">
                  <div className="thinking-inline">
                    <span className="thinking-dots" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                    <span>Thinking through the context</span>
                    <span className="thinking-time">{elapsedLabel}</span>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        );
      })()}

      {snapshot.error ? (
        <div className="chat-error" role="alert">{snapshot.error}</div>
      ) : null}

      {!hasHermesBridge ? (
        <div className="chat-fallback">
          Hermes integration requires the Launch Bay Electron window. Restart with pnpm dev so the preload bridge is rebuilt.
        </div>
      ) : null}

      <div
        className="composer-wrap"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={(event) => void handleDrop(event)}
      >
        {slashSuggestions.length > 0 ? (
          <ul className="slash-suggestions" role="listbox" aria-label="Slash commands and skills">
            {slashSuggestions.map((cmd, idx) => (
              <li
                key={`${cmd.source}-${cmd.name}`}
                role="option"
                aria-selected={idx === slashHighlight}
                className={`slash-suggestion${idx === slashHighlight ? ' is-active' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  applySlashSuggestion(cmd);
                }}
                onMouseEnter={() => setSlashHighlight(idx)}
              >
                <span className="slash-suggestion-name">/{cmd.name}</span>
                {cmd.source === 'skill' ? <span className="slash-suggestion-badge">skill</span> : null}
                {cmd.description ? (
                  <span className="slash-suggestion-desc">{cmd.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {mentionSuggestions.length > 0 ? (
          <ul className="slash-suggestions" role="listbox" aria-label="Project files">
            {mentionSuggestions.map((file, idx) => (
              <li
                key={file}
                role="option"
                aria-selected={idx === mentionHighlight}
                className={`slash-suggestion${idx === mentionHighlight ? ' is-active' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  void applyMentionSuggestion(file);
                }}
                onMouseEnter={() => setMentionHighlight(idx)}
              >
                <span className="slash-suggestion-name">@{file}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="composer">
          {onApprovalModeChange ? (
            <label className="approval-toggle" title="Require approval for tool calls">
              <input
                type="checkbox"
                checked={approvalMode === 'manual'}
                onChange={(event) => onApprovalModeChange(event.target.checked ? 'manual' : 'auto')}
              />
              Manual approval
            </label>
          ) : null}
          {attachments.length > 0 || resources.length > 0 ? (
            <ul className="composer-attachments" aria-label="Pending attachments">
              {attachments.map((attachment) => {
                const src = `data:${attachment.mimeType};base64,${attachment.data}`;
                return (
                  <li key={attachment.id ?? attachment.name ?? src} className="composer-attachment">
                    <img src={src} alt={attachment.name ?? 'Pasted image'} />
                    {attachment.name ? (
                      <span className="composer-attachment-name">{attachment.name}</span>
                    ) : null}
                    {onRemoveAttachment ? (
                      <button
                        type="button"
                        className="composer-attachment-remove"
                        aria-label={`Remove ${attachment.name ?? 'attachment'}`}
                        onClick={() => attachment.id && onRemoveAttachment(attachment.id)}
                      >
                        ×
                      </button>
                    ) : null}
                  </li>
                );
              })}
              {resources.map((resource) => {
                const isBlob = typeof resource.blob === 'string';
                return (
                  <li
                    key={resource.id ?? resource.uri}
                    className="composer-attachment composer-attachment-file"
                  >
                    <div className="composer-attachment-file-icon" aria-hidden="true">
                      {isBlob ? 'PDF' : 'TXT'}
                    </div>
                    <span className="composer-attachment-name">
                      {resource.name ?? resource.uri.split('/').pop() ?? 'file'}
                    </span>
                    {onRemoveResource ? (
                      <button
                        type="button"
                        className="composer-attachment-remove"
                        aria-label={`Remove ${resource.name ?? 'file'}`}
                        onClick={() => resource.id && onRemoveResource(resource.id)}
                      >
                        ×
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          <div className="input-line">
            {isThinking ? `${sessionName} is working · ${elapsedLabel}` : `Message ${sessionName}`}
          </div>
          <textarea
            ref={composerInputRef}
            rows={1}
            id={attachInputId}
            aria-label={`Message ${sessionName} about ${projectName}`}
            className="composer-input"
            placeholder={sessionPrompt}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            onPaste={(event) => void handleComposerPaste(event)}
            disabled={!hasHermesBridge}
          />
          <div className="composer-bottom">
            <button className="text-button" onClick={onReset} disabled={!hasHermesBridge}>Reset session</button>
            {onOpenHistory ? (
              <button
                type="button"
                className="text-button"
                aria-label="Past sessions"
                onClick={onOpenHistory}
                disabled={!hasHermesBridge}
              >
                History
              </button>
            ) : null}
            {canAttach ? (
              <button
                type="button"
                className="text-button composer-attach"
                aria-label="Attach file"
                onClick={() => void handlePickAttachment()}
              >
                📎 Attach
              </button>
            ) : null}
            <span className="label">{projectName}</span>
            <span className="context-usage" aria-label="Hermes context usage">{contextUsageLabel}</span>
            <span className="push" />
            {isThinking && onCancel ? (
              <button
                type="button"
                className="text-button composer-cancel"
                aria-label="Stop Hermes"
                onClick={onCancel}
              >
                Stop
              </button>
            ) : null}
            <button className="primary" onClick={onSend} disabled={sendDisabled}>Send</button>
          </div>
        </div>
      </div>
    </section>
  );
}
