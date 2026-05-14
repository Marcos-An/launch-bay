import { useEffect } from 'react';
import type { DirectoryInspection, WorkspaceConfig } from '../types';

export type ServerFormState = {
  mode: 'create' | 'edit';
  id?: string;
  workspaceId: string;
  workspaceName: string;
  name: string;
  cwd: string;
  command: string;
  nodeVersion: string;
  url: string;
  description: string;
  inspection?: DirectoryInspection;
  error?: string;
};

type ServerFormModalProps = {
  form: ServerFormState;
  workspaces: WorkspaceConfig[];
  saving: boolean;
  installedNodeVersions: string[];
  nodeVersionsLoading: boolean;
  hasChooseDirBridge: boolean;
  onChange: (next: ServerFormState) => void;
  onClose: () => void;
  onChooseDirectory: () => void;
  onInspectDirectory: (path: string) => void;
  onRefreshNodeVersions: () => void;
  onSave: () => void;
};

export function ServerFormModal({
  form,
  workspaces,
  saving,
  installedNodeVersions,
  nodeVersionsLoading,
  hasChooseDirBridge,
  onChange,
  onClose,
  onChooseDirectory,
  onInspectDirectory,
  onRefreshNodeVersions,
  onSave
}: ServerFormModalProps) {
  useEffect(() => {
    function handleEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      onClose();
    }

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="session-modal server-config-modal" role="dialog" aria-modal="true" aria-label={form.mode === 'create' ? 'New server' : 'Edit server'}>
        <div className="session-modal-head">
          <div>
            <div className="context">Local server</div>
            <h2>{form.mode === 'create' ? 'New server' : 'Edit server'}</h2>
          </div>
          <button className="terminal-action" type="button" onClick={onClose} aria-label="Close server dialog">Close</button>
        </div>
        <label className="field-label">
          <span>Workspace</span>
          <select
            value={form.workspaceId}
            disabled={form.mode === 'edit'}
            onChange={(event) => onChange({ ...form, workspaceId: event.target.value })}
          >
            {workspaces.map((workspace) => (
              <option value={workspace.id} key={workspace.id}>{workspace.name}</option>
            ))}
            <option value="__new__">New workspace…</option>
          </select>
        </label>
        {form.workspaceId === '__new__' ? (
          <label className="field-label">
            <span>New workspace name</span>
            <input value={form.workspaceName} onChange={(event) => onChange({ ...form, workspaceName: event.target.value })} />
          </label>
        ) : null}
        <label className="field-label">
          <span>Server name</span>
          <input value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} placeholder="API, Web, Worker…" />
        </label>
        <label className="field-label">
          <span>Working directory</span>
          <div className="field-row">
            <input
              value={form.cwd}
              onChange={(event) => onChange({ ...form, cwd: event.target.value })}
              onBlur={(event) => onInspectDirectory(event.target.value)}
              placeholder="/Users/me/project"
            />
            <button className="secondary" type="button" onClick={onChooseDirectory} disabled={!hasChooseDirBridge}>Choose folder</button>
          </div>
        </label>
        {form.inspection ? (
          <div className={`directory-inspection ${form.inspection.isGitRepository ? 'directory-inspection-ok' : ''}`} role="status">
            {form.inspection.error
              ? form.inspection.error
              : form.inspection.isGitRepository
                ? `Git repository · ${form.inspection.branch ?? 'detached'}${form.inspection.dirty ? ' · dirty' : ''}`
                : 'Folder selected · not a Git repository'}
          </div>
        ) : null}
        <label className="field-label">
          <span>Start command</span>
          <input value={form.command} onChange={(event) => onChange({ ...form, command: event.target.value })} placeholder="pnpm dev" />
        </label>
        <div className="field-label">
          <label htmlFor="server-node-version">Node version</label>
          <div className="field-row">
            <select
              id="server-node-version"
              value={form.nodeVersion}
              onChange={(event) => onChange({ ...form, nodeVersion: event.target.value })}
              aria-describedby="node-version-help"
            >
              <option value="">Auto (.nvmrc / PATH)</option>
              {installedNodeVersions.map((version) => (
                <option value={version} key={version}>v{version}</option>
              ))}
            </select>
            <button className="secondary" type="button" onClick={onRefreshNodeVersions} disabled={nodeVersionsLoading}>
              {nodeVersionsLoading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
          <span id="node-version-help" className="field-help">
            Only Node versions installed in NVM are selectable. Install another version with NVM, then refresh this list.
          </span>
        </div>
        <label className="field-label">
          <span>Local URL</span>
          <input value={form.url} onChange={(event) => onChange({ ...form, url: event.target.value })} placeholder="http://localhost:5173" />
        </label>
        <label className="field-label">
          <span>Description</span>
          <input value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} placeholder="Optional" />
        </label>
        {form.error ? <div className="config-warning" role="alert">{form.error}</div> : null}
        <div className="session-modal-actions">
          <button className="secondary" type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="button" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save server'}</button>
        </div>
      </section>
    </div>
  );
}
