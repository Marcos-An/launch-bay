import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type ServerDefaults = {
  name?: string;
  command?: string;
  url?: string;
  description?: string;
};

export type DirectoryInspection = {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  isGitRepository: boolean;
  branch?: string;
  dirty?: boolean;
  error?: string;
  serverDefaults?: ServerDefaults;
};

function readGitValue(cwd: string, args: string[]) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return undefined;
  }
}

type PackageJson = {
  name?: unknown;
  description?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
};

function readJsonFile(path: string): PackageJson | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
  } catch {
    return undefined;
  }
}

function hasFile(cwd: string, filename: string) {
  return existsSync(join(cwd, filename));
}

function detectPackageRunner(cwd: string, scriptName: string) {
  if (hasFile(cwd, 'pnpm-lock.yaml')) return `pnpm ${scriptName}`;
  if (hasFile(cwd, 'yarn.lock')) return `yarn ${scriptName}`;
  if (hasFile(cwd, 'bun.lockb') || hasFile(cwd, 'bun.lock')) return `bun run ${scriptName}`;
  if (scriptName === 'start') return 'npm start';
  return `npm run ${scriptName}`;
}

function readScripts(packageJson: PackageJson): Record<string, string> {
  if (!packageJson.scripts || typeof packageJson.scripts !== 'object') return {};
  return Object.fromEntries(
    Object.entries(packageJson.scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

function hasDependency(packageJson: PackageJson, name: string) {
  const dependencyGroups = [packageJson.dependencies, packageJson.devDependencies];
  return dependencyGroups.some((group) => group && typeof group === 'object' && Object.prototype.hasOwnProperty.call(group, name));
}

function inferPortFromScript(script: string): number | undefined {
  const explicitFlag = script.match(/(?:--port|-p)\s+([0-9]{2,5})\b/);
  if (explicitFlag) return Number(explicitFlag[1]);
  const envPort = script.match(/(?:^|\s)(?:PORT|VITE_PORT)\s*=\s*([0-9]{2,5})\b/);
  if (envPort) return Number(envPort[1]);
  return undefined;
}

function inferPortFromViteConfig(cwd: string): number | undefined {
  const configFile = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'].find((file) => hasFile(cwd, file));
  if (!configFile) return undefined;
  try {
    const content = readFileSync(join(cwd, configFile), 'utf8');
    const serverBlock = content.match(/server\s*:\s*\{[\s\S]*?\}/);
    const portMatch = (serverBlock?.[0] ?? content).match(/port\s*:\s*([0-9]{2,5})\b/);
    return portMatch ? Number(portMatch[1]) : undefined;
  } catch {
    return undefined;
  }
}

function inferDefaultPort(cwd: string, packageJson: PackageJson, selectedScript?: string): number | undefined {
  const scriptedPort = selectedScript ? inferPortFromScript(selectedScript) : undefined;
  if (scriptedPort) return scriptedPort;

  if (selectedScript?.includes('vite') || hasDependency(packageJson, 'vite')) {
    return inferPortFromViteConfig(cwd) ?? 5173;
  }
  if (selectedScript?.includes('next') || hasDependency(packageJson, 'next')) return 3000;
  if (selectedScript?.includes('react-scripts') || hasDependency(packageJson, 'react-scripts')) return 3000;
  if (selectedScript?.includes('astro') || hasDependency(packageJson, 'astro')) return 4321;
  return undefined;
}

function inferServerDefaults(cwd: string): ServerDefaults | undefined {
  const packageJson = readJsonFile(join(cwd, 'package.json'));
  if (!packageJson) return undefined;

  const scripts = readScripts(packageJson);
  const selectedScriptName = ['dev', 'start', 'serve', 'preview'].find((scriptName) => scripts[scriptName]);
  const selectedScript = selectedScriptName ? scripts[selectedScriptName] : undefined;
  const port = inferDefaultPort(cwd, packageJson, selectedScript);
  const defaults: ServerDefaults = {
    name: typeof packageJson.name === 'string' && packageJson.name.trim() ? packageJson.name.trim() : undefined,
    command: selectedScriptName ? detectPackageRunner(cwd, selectedScriptName) : undefined,
    url: port ? `http://localhost:${port}` : undefined,
    description: typeof packageJson.description === 'string' && packageJson.description.trim()
      ? packageJson.description.trim()
      : undefined
  };

  return Object.values(defaults).some(Boolean) ? defaults : undefined;
}

export function inspectServerDirectory(path: string): DirectoryInspection {
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return { path, exists: false, isDirectory: false, isGitRepository: false, error: 'Choose a working directory.' };
  }

  if (!existsSync(trimmedPath)) {
    return { path: trimmedPath, exists: false, isDirectory: false, isGitRepository: false, error: 'Directory does not exist.' };
  }

  const isDirectory = statSync(trimmedPath).isDirectory();
  if (!isDirectory) {
    return { path: trimmedPath, exists: true, isDirectory: false, isGitRepository: false, error: 'Path is not a directory.' };
  }

  const serverDefaults = inferServerDefaults(trimmedPath);
  const inside = readGitValue(trimmedPath, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') return { path: trimmedPath, exists: true, isDirectory: true, isGitRepository: false, serverDefaults };

  const branch = readGitValue(trimmedPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    ?? readGitValue(trimmedPath, ['symbolic-ref', '--short', 'HEAD']);
  const status = readGitValue(trimmedPath, ['status', '--porcelain']);
  return {
    path: trimmedPath,
    exists: true,
    isDirectory: true,
    isGitRepository: true,
    branch: branch && branch !== 'HEAD' ? branch : undefined,
    dirty: (status ?? '').trim().length > 0,
    serverDefaults
  };
}
