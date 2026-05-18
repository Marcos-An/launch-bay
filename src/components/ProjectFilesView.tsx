import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectFileEntry } from '../types';

const PROJECT_FILE_TREE_REFRESH_MS = 5000;

type ProjectFilesViewProps = {
  projectId: string;
  projectName: string;
};

type FileLoadState = 'idle' | 'loading' | 'ready' | 'error';
type HighlightToken = { text: string; className?: string };
type RenderProjectFileEntry = ProjectFileEntry & { synthetic?: boolean };

const TS_KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'do', 'else',
  'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'interface',
  'let', 'new', 'null', 'of', 'return', 'switch', 'throw', 'true', 'try', 'type', 'undefined', 'while'
]);

function pathDepth(path: string) {
  return Math.max(0, path.split('/').filter(Boolean).length - 1);
}

function indentForPath(path: string) {
  return pathDepth(path) * 12;
}

function parentPathsFor(path: string) {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join('/'));
}

function parentPathFor(path: string) {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(0, -1).join('/');
}

function nameFromPath(path: string) {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

function compareTreeEntries(left: RenderProjectFileEntry, right: RenderProjectFileEntry) {
  if (left.type === 'directory' && right.type !== 'directory') return -1;
  if (left.type !== 'directory' && right.type === 'directory') return 1;
  return left.name.localeCompare(right.name);
}

function buildVisibleTreeEntries(entries: ProjectFileEntry[], expandedPaths: Set<string>) {
  const byPath = new Map<string, RenderProjectFileEntry>();

  for (const entry of entries) {
    byPath.set(entry.path, entry);
    for (const parentPath of parentPathsFor(entry.path)) {
      if (byPath.has(parentPath)) continue;
      byPath.set(parentPath, {
        path: parentPath,
        name: nameFromPath(parentPath),
        type: 'directory',
        synthetic: true
      });
    }
  }

  const childrenByParent = new Map<string, RenderProjectFileEntry[]>();
  for (const entry of byPath.values()) {
    const parentPath = parentPathFor(entry.path);
    const children = childrenByParent.get(parentPath) ?? [];
    children.push(entry);
    childrenByParent.set(parentPath, children);
  }

  const visibleEntries: RenderProjectFileEntry[] = [];
  const appendChildren = (parentPath: string) => {
    const children = [...(childrenByParent.get(parentPath) ?? [])].sort(compareTreeEntries);
    for (const child of children) {
      visibleEntries.push(child);
      if (child.type === 'directory' && expandedPaths.has(child.path)) appendChildren(child.path);
    }
  };

  appendChildren('');
  return visibleEntries;
}

function fileIconClass(_path: string, _sensitive?: boolean) {
  return 'file-generic';
}

function tokenizeCodeLine(line: string, selectedPath?: string): HighlightToken[] {
  if (selectedPath?.includes('.env')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)(=)(.*)$/);
    if (match) {
      return [
        { text: match[1], className: 'syntax-key' },
        { text: match[2], className: 'syntax-operator' },
        { text: match[3], className: 'syntax-string' }
      ];
    }
  }

  const tokens: HighlightToken[] = [];
  const pattern = /(\/\/.*$|`[^`]*`|'[^']*'|"[^"]*"|<[\/?]?[A-Za-z][A-Za-z0-9.:-]*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b|[{}()[\].,;:+\-*\/=<>!?|&]+)/g;
  let lastIndex = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) tokens.push({ text: line.slice(lastIndex, index) });
    const text = match[0];
    let className: string | undefined;
    if (text.startsWith('//')) className = 'syntax-comment';
    else if (text.startsWith('"') || text.startsWith("'") || text.startsWith('`')) className = 'syntax-string';
    else if (text.startsWith('<')) className = 'syntax-tag';
    else if (/^\d/.test(text)) className = 'syntax-number';
    else if (TS_KEYWORDS.has(text)) className = text === 'true' || text === 'false' || text === 'null' || text === 'undefined'
      ? 'syntax-constant'
      : 'syntax-keyword';
    else if (/^[{}()[\].,;:+\-*\/=<>!?|&]+$/.test(text)) className = 'syntax-operator';
    tokens.push({ text, className });
    lastIndex = index + text.length;
  }
  if (lastIndex < line.length) tokens.push({ text: line.slice(lastIndex) });
  return tokens.length > 0 ? tokens : [{ text: line || ' ' }];
}

function SyntaxHighlight({ text, selectedPath }: { text: string; selectedPath?: string }) {
  const lines = text.endsWith('\n') ? `${text} ` : text;
  return (
    <>
      {lines.split('\n').map((line, lineIndex) => (
        <span className="syntax-line" key={`${lineIndex}:${line}`}>
          {tokenizeCodeLine(line, selectedPath).map((token, tokenIndex) => (
            <span className={token.className} key={`${tokenIndex}:${token.text}`}>{token.text}</span>
          ))}
          {'\n'}
        </span>
      ))}
    </>
  );
}

export function ProjectFilesView({ projectId, projectName }: ProjectFilesViewProps) {
  const [entries, setEntries] = useState<ProjectFileEntry[]>([]);
  const [loadingTree, setLoadingTree] = useState(false);
  const [treeError, setTreeError] = useState<string | undefined>(undefined);
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined);
  const [savedText, setSavedText] = useState('');
  const [draftText, setDraftText] = useState('');
  const [selectedSensitive, setSelectedSensitive] = useState(false);
  const [fileStatus, setFileStatus] = useState<FileLoadState>('idle');
  const [fileError, setFileError] = useState<string | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [savedNotice, setSavedNotice] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const highlightRef = useRef<HTMLPreElement>(null);
  const lineNumbersRef = useRef<HTMLPreElement>(null);

  const selectedEntry = selectedPath ? entries.find((entry) => entry.path === selectedPath) : undefined;
  const visibleEntries = useMemo(() => buildVisibleTreeEntries(entries, expandedPaths), [entries, expandedPaths]);
  const lineCount = useMemo(() => Math.max(1, draftText.split('\n').length), [draftText]);
  const isDirty = fileStatus === 'ready' && draftText !== savedText;

  const refreshProjectState = useCallback(async () => {
    const bridge = window.launchBay;
    if (!bridge?.listProjectTree) {
      setTreeError('Project file bridge is unavailable.');
      setEntries([]);
      return;
    }

    setLoadingTree(true);
    setTreeError(undefined);
    try {
      const treeResult = await bridge.listProjectTree(projectId, { includeHidden: true });
      setEntries(treeResult.entries ?? []);
      setTreeError(treeResult.error);
    } catch (error) {
      setTreeError(error instanceof Error ? error.message : String(error));
      setEntries([]);
    } finally {
      setLoadingTree(false);
    }
  }, [projectId]);

  const openFile = useCallback(async (path: string) => {
    const bridge = window.launchBay;
    if (!bridge?.readProjectRuntimeFile) {
      setFileStatus('error');
      setFileError('Project file reader is unavailable.');
      return;
    }

    setSelectedPath(path);
    setExpandedPaths((current) => new Set([...current, ...parentPathsFor(path)]));
    setFileStatus('loading');
    setFileError(undefined);
    setSaveError(undefined);
    setSavedNotice(false);
    try {
      const result = await bridge.readProjectRuntimeFile(projectId, path);
      if (result.error || typeof result.text !== 'string') {
        setFileStatus('error');
        setFileError(result.error ?? 'File could not be read.');
        setSavedText('');
        setDraftText('');
        setSelectedSensitive(Boolean(result.sensitive));
        return;
      }
      setSavedText(result.text);
      setDraftText(result.text);
      setSelectedSensitive(Boolean(result.sensitive));
      setFileStatus('ready');
    } catch (error) {
      setFileStatus('error');
      setFileError(error instanceof Error ? error.message : String(error));
    }
  }, [projectId]);

  const saveFile = useCallback(async () => {
    if (!selectedPath || !window.launchBay?.writeProjectRuntimeFile) return;
    setSaveError(undefined);
    setSavedNotice(false);
    const result = await window.launchBay.writeProjectRuntimeFile(projectId, selectedPath, draftText);
    if (!result.ok) {
      setSaveError(result.error ?? 'File could not be saved.');
      return;
    }
    setSavedText(draftText);
    setSelectedSensitive(Boolean(result.sensitive));
    setSavedNotice(true);
    await refreshProjectState();
  }, [draftText, projectId, refreshProjectState, selectedPath]);

  useEffect(() => {
    void refreshProjectState();
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refreshProjectState();
    };
    const intervalId = window.setInterval(refreshWhenVisible, PROJECT_FILE_TREE_REFRESH_MS);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [refreshProjectState]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((!event.metaKey && !event.ctrlKey) || event.key.toLowerCase() !== 's') return;
      if (!selectedPath) return;
      event.preventDefault();
      if (isDirty) void saveFile();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isDirty, saveFile, selectedPath]);

  const toggleDirectory = (path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <section className="project-files-view" aria-label="Project files">
      <div className="project-files-shell">
        <aside className="project-files-sidebar" aria-label="Project file browser">
          <div className="project-files-toolbar">
            <div>
              <span className="project-files-title">Files</span>
              <span className="project-files-context">{projectName}</span>
            </div>
            <button className="icon-button" type="button" aria-label="Refresh files" onClick={() => void refreshProjectState()} disabled={loadingTree}>
              {loadingTree ? '…' : '↻'}
            </button>
          </div>

          <section className="project-files-section" aria-label="Project tree section">
            <div className="project-files-section-title">Project</div>
            {treeError ? <p className="project-files-error" role="alert">{treeError}</p> : null}
            <div className="project-file-tree" role="tree" aria-label="Project file tree">
              {visibleEntries.map((entry) => {
                const isDirectory = entry.type === 'directory';
                const isExpanded = expandedPaths.has(entry.path);
                const depthPadding = 12 + indentForPath(entry.path);
                if (isDirectory) {
                  return (
                    <button
                      key={entry.path}
                      className="project-file-row project-file-directory project-file-clickable"
                      type="button"
                      aria-expanded={isExpanded}
                      aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${entry.path}`}
                      style={{ paddingLeft: depthPadding }}
                      onClick={() => toggleDirectory(entry.path)}
                    >
                      <span className="project-file-disclosure" aria-hidden="true">{isExpanded ? '⌄' : '›'}</span>
                      <span className={`project-file-icon ${isExpanded ? 'folder-open' : 'folder'}`} aria-hidden="true" />
                      <span className="project-file-name">{entry.name}</span>
                    </button>
                  );
                }

                return (
                  <button
                    key={entry.path}
                    className={`project-file-row project-file-clickable ${selectedPath === entry.path ? 'active' : ''}`}
                    type="button"
                    aria-label={`Open ${entry.path}`}
                    style={{ paddingLeft: depthPadding }}
                    onClick={() => void openFile(entry.path)}
                  >
                    <span className="project-file-disclosure" aria-hidden="true" />
                    <span className={`project-file-icon ${fileIconClass(entry.path, entry.sensitive)}`} aria-hidden="true" />
                    <span className="project-file-name">{entry.name}</span>
                    {entry.sensitive ? <span className="project-file-pill">Sensitive</span> : null}
                  </button>
                );
              })}
              {entries.length === 0 && !loadingTree ? <p className="project-files-muted">No files found</p> : null}
              {entries.length > 0 && visibleEntries.length === 0 ? <p className="project-files-muted">No visible files</p> : null}
            </div>
          </section>
        </aside>

        <section className="project-editor-pane" aria-label="Text editor">
          {selectedPath ? (
            <>
              <header className="project-editor-header">
                <div>
                  <span className="project-editor-path">{selectedPath}</span>
                  <div className="project-editor-meta">
                    {selectedSensitive || selectedEntry?.sensitive ? <span className="project-file-sensitive">Sensitive local file</span> : null}
                    {isDirty ? <span className="project-file-unsaved">Unsaved</span> : savedNotice ? <span className="project-file-saved">Saved</span> : null}
                  </div>
                </div>
                <div className="project-editor-actions">
                  <button className="text-button" type="button" onClick={() => setDraftText(savedText)} disabled={!isDirty}>Revert</button>
                </div>
              </header>
              {fileStatus === 'loading' ? <p className="project-files-muted project-editor-message">Loading file…</p> : null}
              {fileStatus === 'error' ? <p className="project-files-error" role="alert">{fileError}</p> : null}
              {saveError ? <p className="project-files-error" role="alert">{saveError}</p> : null}
              {fileStatus === 'ready' ? (
                <div className="project-code-editor">
                  <pre className="project-line-numbers" data-testid="line-numbers" aria-hidden="true" ref={lineNumbersRef}>
                    {Array.from({ length: lineCount }, (_line, index) => (
                      <span className="project-line-number" key={index}>{index + 1}</span>
                    ))}
                  </pre>
                  <div className="project-code-scroll">
                    <pre className="project-code-highlight" data-testid="syntax-highlight" aria-hidden="true" ref={highlightRef}>
                      <SyntaxHighlight text={draftText} selectedPath={selectedPath} />
                    </pre>
                    <textarea
                      className="project-text-editor"
                      aria-label={`Editor for ${selectedPath}`}
                      spellCheck={false}
                      value={draftText}
                      onScroll={(event) => {
                        if (highlightRef.current) {
                          highlightRef.current.scrollTop = event.currentTarget.scrollTop;
                          highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
                        }
                        if (lineNumbersRef.current) lineNumbersRef.current.scrollTop = event.currentTarget.scrollTop;
                      }}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                          event.preventDefault();
                          if (isDirty) void saveFile();
                        }
                      }}
                      onChange={(event) => {
                        setDraftText(event.target.value);
                        setSavedNotice(false);
                      }}
                    />
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className="project-editor-empty">
              <h2>Select a file</h2>
              <p>Open a project file from the tree to edit its text.</p>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
