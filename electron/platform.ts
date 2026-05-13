import { existsSync } from 'node:fs';

const PWSH_CANDIDATES_WIN32 = [
  // PowerShell 7+ if the user installed it (preferred — fewer encoding quirks
  // and lines up with most modern Windows dev environments).
  process.env.PROGRAMFILES ? `${process.env.PROGRAMFILES}\\PowerShell\\7\\pwsh.exe` : undefined,
  process.env['PROGRAMFILES(X86)']
    ? `${process.env['PROGRAMFILES(X86)']}\\PowerShell\\7\\pwsh.exe`
    : undefined
].filter((p): p is string => Boolean(p));

const POSIX_LOGIN_SHELLS = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'];

/**
 * Resolve a sensible login shell for the current OS.
 *
 * - macOS / Linux: prefer `$SHELL` when it points at an existing executable,
 *   fall back to zsh, bash, then sh. Flags are `-lc` so the resulting child
 *   process sources the user's profile (PATH, aliases, etc.).
 * - Windows: prefer PowerShell 7 if installed (`pwsh.exe`), otherwise fall
 *   back to `%ComSpec%` (typically `cmd.exe`). Flags differ per shell.
 *
 * Returned `args` always ends with the flag that consumes a single command
 * string. Callers append the command as the last argument.
 */
export function loginShellInvocation(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    for (const candidate of PWSH_CANDIDATES_WIN32) {
      if (existsSync(candidate)) return { command: candidate, args: ['-NoLogo', '-NoProfile', '-Command'] };
    }
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'] };
  }
  for (const candidate of POSIX_LOGIN_SHELLS) {
    if (candidate && existsSync(candidate)) return { command: candidate, args: ['-lc'] };
  }
  // Last-ditch fallback: bash is in PATH on virtually every POSIX system.
  return { command: 'bash', args: ['-lc'] };
}

/**
 * Resolve a shell for the embedded terminal (interactive). Same OS rules,
 * but the args turn the shell into an interactive login shell rather than a
 * one-shot command runner.
 */
export function interactiveShellInvocation(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    for (const candidate of PWSH_CANDIDATES_WIN32) {
      if (existsSync(candidate)) return { command: candidate, args: ['-NoLogo'] };
    }
    return { command: process.env.ComSpec || 'cmd.exe', args: [] };
  }
  for (const candidate of POSIX_LOGIN_SHELLS) {
    if (candidate && existsSync(candidate)) return { command: candidate, args: ['-l'] };
  }
  return { command: 'bash', args: ['-l'] };
}

/**
 * Build a shell-agnostic command to ask the OS for the absolute path of a
 * binary on PATH. On POSIX, `command -v` is portable across sh/bash/zsh; on
 * Windows, `where` is the canonical equivalent (returns one path per line).
 */
export function whichCommand(name: string): string {
  // We pass this string straight to the shell, so make sure it cannot
  // smuggle additional commands via shell metacharacters.
  const safe = name.replace(/[^a-zA-Z0-9._:/\\-]/g, '');
  if (process.platform === 'win32') return `where ${safe}`;
  return `command -v ${safe}`;
}
