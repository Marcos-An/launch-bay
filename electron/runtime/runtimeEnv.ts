const BLOCKED_ENV_NAMES = new Set([
  'NODE_ENV',
  'NODE_OPTIONS',
  'INIT_CWD',
  'npm_command',
  'npm_config_user_agent',
  'npm_execpath',
  'npm_lifecycle_event',
  'npm_lifecycle_script',
  'npm_node_execpath',
  'npm_package_json',
  'npm_package_name',
  'npm_package_version',
  'pnpm_config_verify_deps_before_run'
]);

function isBlockedEnvName(name: string) {
  return BLOCKED_ENV_NAMES.has(name) || name.startsWith('npm_config_') || name.startsWith('npm_package_');
}

function isLaunchBayPathSegment(segment: string) {
  return (
    /(^|\/)launch-bay\/node_modules\/\.bin$/.test(segment) ||
    segment.includes('/snapshot/dist/node-gyp-bin')
  );
}

function cleanPath(pathValue: string | undefined) {
  if (!pathValue) return pathValue;
  const separator = process.platform === 'win32' ? ';' : ':';
  return pathValue
    .split(separator)
    .filter((segment) => segment && !isLaunchBayPathSegment(segment))
    .join(separator);
}

export function buildUserTerminalEnv(
  overrides: Record<string, string | undefined> = {},
  options: { prependPath?: string; term?: string } = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || isBlockedEnvName(key)) continue;
    env[key] = value;
  }

  const cleanedPath = cleanPath(env.PATH);
  if (cleanedPath !== undefined) env.PATH = cleanedPath;

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  if (options.prependPath) {
    const separator = process.platform === 'win32' ? ';' : ':';
    env.PATH = env.PATH ? `${options.prependPath}${separator}${env.PATH}` : options.prependPath;
  }

  env.TERM = options.term ?? env.TERM ?? 'xterm-256color';
  env.COLORTERM = overrides.COLORTERM ?? env.COLORTERM ?? 'truecolor';

  return env;
}
