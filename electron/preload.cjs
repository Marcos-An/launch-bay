const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launchBay', {
  openLocalUrl: (url) => ipcRenderer.invoke('launch-bay:open-local-url', url),
  getLaunchBayConfig: () => ipcRenderer.invoke('launch-bay:config-get'),
  saveWorkspace: (draft) => ipcRenderer.invoke('launch-bay:workspace-save', draft),
  deleteWorkspace: (workspaceId) => ipcRenderer.invoke('launch-bay:workspace-delete', workspaceId),
  saveServerConfig: (draft) => ipcRenderer.invoke('launch-bay:server-config-save', draft),
  deleteServerConfig: (serverId) => ipcRenderer.invoke('launch-bay:server-config-delete', serverId),
  chooseServerDirectory: () => ipcRenderer.invoke('launch-bay:server-directory-choose'),
  inspectServerDirectory: (path) => ipcRenderer.invoke('launch-bay:server-directory-inspect', path),
  getRuntimeStatus: (projectId) => ipcRenderer.invoke('launch-bay:runtime-status', projectId),
  startProject: (projectId) => ipcRenderer.invoke('launch-bay:start-project', projectId),
  stopProject: (projectId) => ipcRenderer.invoke('launch-bay:stop-project', projectId),
  onRuntimeUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('launch-bay:runtime-update', listener);
    return () => ipcRenderer.removeListener('launch-bay:runtime-update', listener);
  },
  sendHermesMessage: (projectId, text, attachments, resources) =>
    ipcRenderer.invoke('launch-bay:hermes-send', projectId, text, attachments, resources),
  getHermesSession: (projectId) => ipcRenderer.invoke('launch-bay:hermes-session', projectId),
  resetHermesSession: (projectId) => ipcRenderer.invoke('launch-bay:hermes-reset', projectId),
  cancelHermesPrompt: (projectId) => ipcRenderer.invoke('launch-bay:hermes-cancel', projectId),
  listHermesSessions: (cwd) => ipcRenderer.invoke('launch-bay:hermes-sessions-list', cwd),
  resumeHermesSession: (projectId, sessionId) =>
    ipcRenderer.invoke('launch-bay:hermes-resume-session', projectId, sessionId),
  listProjectFiles: (cwd) => ipcRenderer.invoke('launch-bay:list-project-files', cwd),
  listHermesSkills: () => ipcRenderer.invoke('launch-bay:list-hermes-skills'),
  readProjectFile: (cwd, relativePath) =>
    ipcRenderer.invoke('launch-bay:read-project-file', cwd, relativePath),
  setHermesApprovalMode: (mode) => ipcRenderer.invoke('launch-bay:hermes-approval-mode', mode),
  respondToHermesPermission: (requestId, optionId) =>
    ipcRenderer.invoke('launch-bay:hermes-approval-respond', requestId, optionId),
  onHermesPermissionRequired: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('launch-bay:hermes-permission-required', listener);
    return () => ipcRenderer.removeListener('launch-bay:hermes-permission-required', listener);
  },
  chooseImageFile: () => ipcRenderer.invoke('launch-bay:choose-image-file'),
  chooseAttachmentFile: () => ipcRenderer.invoke('launch-bay:choose-attachment-file'),
  onHermesUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('launch-bay:hermes-update', listener);
    return () => ipcRenderer.removeListener('launch-bay:hermes-update', listener);
  },
  createTerminal: (projectId, cwd) => ipcRenderer.invoke('launch-bay:terminal-create', projectId, cwd),
  writeTerminal: (id, data) => ipcRenderer.invoke('launch-bay:terminal-write', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.invoke('launch-bay:terminal-resize', id, cols, rows),
  killTerminal: (id) => ipcRenderer.invoke('launch-bay:terminal-kill', id),
  listTerminals: (projectId) => ipcRenderer.invoke('launch-bay:terminal-list', projectId),
  onTerminalData: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('launch-bay:terminal-data', listener);
    return () => ipcRenderer.removeListener('launch-bay:terminal-data', listener);
  },
  onTerminalExit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('launch-bay:terminal-exit', listener);
    return () => ipcRenderer.removeListener('launch-bay:terminal-exit', listener);
  },
  createHermesInstance: (projectId) => ipcRenderer.invoke('launch-bay:hermes-instance-create', projectId),
  listHermesInstances: (projectId) => ipcRenderer.invoke('launch-bay:hermes-instance-list', projectId),
  sendHermesInstanceMessage: (instanceId, text, attachments, resources) =>
    ipcRenderer.invoke('launch-bay:hermes-instance-send', instanceId, text, attachments, resources),
  resetHermesInstance: (instanceId) => ipcRenderer.invoke('launch-bay:hermes-instance-reset', instanceId),
  closeHermesInstance: (instanceId) => ipcRenderer.invoke('launch-bay:hermes-instance-close', instanceId),
  cancelHermesInstancePrompt: (instanceId) =>
    ipcRenderer.invoke('launch-bay:hermes-instance-cancel', instanceId),
  detectAgentCliTools: () => ipcRenderer.invoke('launch-bay:agent-cli-tools'),
  listProjectBranches: (projectId) => ipcRenderer.invoke('launch-bay:project-branches', projectId),
  fetchProjectBranches: (projectId) => ipcRenderer.invoke('launch-bay:project-branches-fetch', projectId),
  switchProjectBranch: (projectId, branch) => ipcRenderer.invoke('launch-bay:project-branch-switch', projectId, branch),
  mergeProjectBranch: (projectId, branch) => ipcRenderer.invoke('launch-bay:project-branch-merge', projectId, branch),
  onHermesInstanceUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('launch-bay:hermes-instance-update', listener);
    return () => ipcRenderer.removeListener('launch-bay:hermes-instance-update', listener);
  }
});
