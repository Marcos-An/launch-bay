import type { GitBranchInfo, GitMergePreview, HermesInstanceSnapshot, TerminalSnapshot } from './types';

export type ProjectStatus = 'running' | 'stopped' | 'draft';
export type Surface = 'hermes' | 'server' | 'agent-session';
export type AgentSessionKind = 'hermes' | 'claude' | 'codex' | 'opencode' | 'gemini' | 'aider';

export type GitOperation = 'fetch' | 'switch' | 'merge';

export type ActiveGitOperation = {
  projectId: string;
  action: GitOperation;
  branch?: string;
};

export type MergeConfirmation = {
  projectId: string;
  sourceBranch: string;
  targetBranch: string;
  repoCwd: string;
  sourceBranchInfo?: GitBranchInfo;
  targetBranchInfo?: GitBranchInfo;
  preview?: GitMergePreview;
  previewStatus: 'idle' | 'loading' | 'ready' | 'error';
  previewError?: string;
};

export type EmbeddedTerminal = TerminalSnapshot & {
  output: string;
  status: 'running' | 'exited';
};

export type AgentSession = HermesInstanceSnapshot & {
  kind: AgentSessionKind;
  name: string;
  command: string;
  draft: string;
};

export type Project = {
  id: string;
  name: string;
  status: ProjectStatus;
  command: string;
  cwd: string;
  url: string;
  serverSub: string;
  prompt: string;
  suggestions: string[];
  log: string;
};
