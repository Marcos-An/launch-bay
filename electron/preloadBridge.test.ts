// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Electron preload bridge packaging', () => {
  it('uses a CommonJS preload file because Electron sandbox preloads cannot load ESM imports', () => {
    const mainSource = readFileSync(join(process.cwd(), 'electron/main.ts'), 'utf8');
    const preloadSource = readFileSync(join(process.cwd(), 'electron/preload.cjs'), 'utf8');

    expect(mainSource).toContain("'preload.cjs'");
    expect(preloadSource).toContain("require('electron')");
    expect(preloadSource).toContain("exposeInMainWorld('launchBay'");
    expect(preloadSource).not.toContain('import ');
  });

  it('exposes Hermes channels on window.launchBay through ipcRenderer', () => {
    const preloadSource = readFileSync(join(process.cwd(), 'electron/preload.cjs'), 'utf8');

    expect(preloadSource).toContain('sendHermesMessage');
    expect(preloadSource).toContain('getHermesSession');
    expect(preloadSource).toContain('resetHermesSession');
    expect(preloadSource).toContain('onHermesUpdate');
    expect(preloadSource).toContain('launch-bay:hermes-send');
    expect(preloadSource).toContain('launch-bay:hermes-session');
    expect(preloadSource).toContain('launch-bay:hermes-reset');
    expect(preloadSource).toContain('launch-bay:hermes-update');
    expect(preloadSource).toContain('openLocalUrl');
    expect(preloadSource).toContain('launch-bay:open-local-url');
    expect(preloadSource).toContain('createTerminal');
    expect(preloadSource).toContain('writeTerminal');
    expect(preloadSource).toContain('killTerminal');
    expect(preloadSource).toContain('launch-bay:terminal-create');
    expect(preloadSource).toContain('launch-bay:terminal-data');
    expect(preloadSource).toContain('createHermesInstance');
    expect(preloadSource).toContain('sendHermesInstanceMessage');
    expect(preloadSource).toContain('resetHermesInstance');
    expect(preloadSource).toContain('closeHermesInstance');
    expect(preloadSource).toContain('getLaunchBayConfig');
    expect(preloadSource).toContain('saveWorkspace');
    expect(preloadSource).toContain('saveServerConfig');
    expect(preloadSource).toContain('chooseServerDirectory');
    expect(preloadSource).toContain('inspectServerDirectory');
    expect(preloadSource).toContain('listNvmNodeVersions');
    expect(preloadSource).toContain('detectAgentCliTools');
    expect(preloadSource).toContain('listProjectBranches');
    expect(preloadSource).toContain('fetchProjectBranches');
    expect(preloadSource).toContain('switchProjectBranch');
    expect(preloadSource).toContain('mergeProjectBranch');
    expect(preloadSource).toContain('getProjectBranchMergePreview');
    expect(preloadSource).toContain('listProjectTree');
    expect(preloadSource).toContain('readProjectRuntimeFile');
    expect(preloadSource).toContain('writeProjectRuntimeFile');
    expect(preloadSource).toContain('launch-bay:hermes-instance-create');
    expect(preloadSource).toContain('launch-bay:config-get');
    expect(preloadSource).toContain('launch-bay:workspace-save');
    expect(preloadSource).toContain('launch-bay:server-config-save');
    expect(preloadSource).toContain('launch-bay:server-directory-choose');
    expect(preloadSource).toContain('launch-bay:server-directory-inspect');
    expect(preloadSource).toContain('launch-bay:nvm-node-versions');
    expect(preloadSource).toContain('launch-bay:agent-cli-tools');
    expect(preloadSource).toContain('launch-bay:project-branches');
    expect(preloadSource).toContain('launch-bay:project-branches-fetch');
    expect(preloadSource).toContain('launch-bay:project-branch-switch');
    expect(preloadSource).toContain('launch-bay:project-branch-merge');
    expect(preloadSource).toContain('launch-bay:project-branch-merge-preview');
  });

  it('registers local project shell IPC handlers in the Electron main process', () => {
    const mainSource = readFileSync(join(process.cwd(), 'electron/main.ts'), 'utf8');

    expect(mainSource).toContain("ipcMain.handle('launch-bay:open-local-url'");
    expect(mainSource).toContain("ipcMain.handle('launch-bay:terminal-create'");
    expect(mainSource).toContain("ipcMain.handle('launch-bay:terminal-write'");
    expect(mainSource).toContain("ipcMain.handle('launch-bay:terminal-kill'");
    expect(mainSource).toContain("ipcMain.handle('launch-bay:hermes-instance-create'");
    expect(mainSource).toMatch(/ipcMain\.handle\(\s*['"]launch-bay:hermes-instance-send['"]/);
    expect(mainSource).toContain("ipcMain.handle('launch-bay:hermes-instance-close'");
    expect(mainSource).toContain("ipcMain.handle('launch-bay:config-get'");
    expect(mainSource).toContain("ipcMain.handle('launch-bay:workspace-save'");
    expect(mainSource).toContain("ipcMain.handle('launch-bay:server-config-save'");
    expect(mainSource).toContain("ipcMain.handle('launch-bay:server-directory-choose'");
    expect(mainSource).toContain("ipcMain.handle('launch-bay:server-directory-inspect'");
    expect(mainSource).toContain("ipcMain.handle('launch-bay:nvm-node-versions'");
    expect(mainSource).toContain("ipcMain.handle('launch-bay:agent-cli-tools'");
    expect(mainSource).toContain("ipcMain.handle('launch-bay:project-branches'");
    expect(mainSource).toContain("ipcMain.handle('launch-bay:project-branches-fetch'");
    expect(mainSource).toContain("ipcMain.handle('launch-bay:project-branch-switch'");
    expect(mainSource).toContain("ipcMain.handle('launch-bay:project-branch-merge'");
    expect(mainSource).toContain("ipcMain.handle('launch-bay:project-branch-merge-preview'");
    expect(mainSource).toContain('shell.openExternal');
    expect(mainSource).toContain('terminalManager.create');
    expect(mainSource).toContain('getHermesInstanceManager().create');
    expect(mainSource).toContain('SUPPORTED_AGENT_CLIS');
    // PATH lookup happens through whichCommand() from ./platform — POSIX
    // turns into `command -v <name>`, Windows into `where <name>`.
    expect(mainSource).toContain('whichCommand');
  });

  it('registers Hermes IPC handlers in the Electron main process', () => {
    const mainSource = readFileSync(join(process.cwd(), 'electron/main.ts'), 'utf8');

    expect(mainSource).toMatch(/ipcMain\.handle\(\s*['"]launch-bay:hermes-send['"]/);
    expect(mainSource).toContain("ipcMain.handle('launch-bay:hermes-session'");
    expect(mainSource).toContain("ipcMain.handle('launch-bay:hermes-reset'");
    expect(mainSource).toContain("'launch-bay:hermes-update'");
  });

  it('talks to Hermes via the local `hermes acp` subprocess instead of HTTP credentials', () => {
    const mainSource = readFileSync(join(process.cwd(), 'electron/main.ts'), 'utf8');
    expect(mainSource).toContain('HermesAcpProcess');
    expect(mainSource).toContain('hermesAcp.kill()');
    expect(mainSource).not.toContain('HERMES_BASE_URL');
    expect(mainSource).not.toContain('API_SERVER_KEY');
  });
});
