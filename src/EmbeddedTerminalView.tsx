import { useEffect, useRef, type KeyboardEvent } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

type EmbeddedTerminalViewProps = {
  id: string;
  title: string;
  cwd: string;
  status: 'running' | 'exited';
  output: string;
  onWrite: (id: string, data: string) => void;
  onResize: (id: string, cols: number, rows: number) => void;
  onKill: (id: string) => void;
  onClose: (id: string) => void;
};

export function EmbeddedTerminalView({
  id,
  title,
  cwd,
  status,
  output,
  onWrite,
  onResize,
  onKill,
  onClose
}: EmbeddedTerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const writtenLengthRef = useRef(0);
  const onWriteRef = useRef(onWrite);
  const onResizeRef = useRef(onResize);
  const statusRef = useRef(status);
  const canMountXterm =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    !window.navigator.userAgent.toLowerCase().includes('jsdom');

  useEffect(() => {
    onWriteRef.current = onWrite;
  }, [onWrite]);

  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (!canMountXterm) return undefined;
    const host = containerRef.current;
    if (!host) return undefined;

    const terminal = new XTerm({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: '"SF Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 8000,
      theme: {
        background: '#0b0b0b',
        foreground: '#e6e6e6',
        cursor: '#f2f2f2',
        selectionBackground: '#3b3b3b',
        black: '#161616',
        red: '#ff7b72',
        green: '#7ee787',
        yellow: '#f2cc60',
        blue: '#79c0ff',
        magenta: '#d2a8ff',
        cyan: '#76e3ea',
        white: '#f0f0f0',
        brightBlack: '#666666',
        brightRed: '#ffa198',
        brightGreen: '#aff5b4',
        brightYellow: '#f8e3a1',
        brightBlue: '#a5d6ff',
        brightMagenta: '#e2c5ff',
        brightCyan: '#b3f0ff',
        brightWhite: '#ffffff'
      }
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const fitAndReport = () => {
      try {
        fitAddon.fit();
        onResizeRef.current(id, terminal.cols, terminal.rows);
      } catch {
        // xterm cannot be fitted while hidden/detached; the next resize/focus will retry.
      }
    };

    const dataDisposable = terminal.onData((data) => {
      if (statusRef.current === 'running') onWriteRef.current(id, data);
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      onResizeRef.current(id, cols, rows);
    });

    const frame = window.requestAnimationFrame(() => {
      fitAndReport();
      terminal.focus();
    });

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(fitAndReport);
      resizeObserver.observe(host);
    }

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
      if (fitAddonRef.current === fitAddon) fitAddonRef.current = null;
      writtenLengthRef.current = 0;
    };
  }, [id, canMountXterm]);

  useEffect(() => {
    if (!canMountXterm) return;
    const terminal = terminalRef.current;
    if (!terminal) return;

    if (output.length < writtenLengthRef.current) {
      terminal.reset();
      writtenLengthRef.current = 0;
    }

    const nextChunk = output.slice(writtenLengthRef.current);
    if (nextChunk) {
      terminal.write(nextChunk);
      writtenLengthRef.current = output.length;
    }
  }, [output, canMountXterm]);

  useEffect(() => {
    if (!canMountXterm) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (status === 'running') {
      terminal.focus();
    }
  }, [status, canMountXterm]);

  function handleFallbackKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (status !== 'running' || event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === 'Enter') {
      event.preventDefault();
      onWrite(id, '\r');
      return;
    }

    if (event.key === 'Backspace') {
      event.preventDefault();
      onWrite(id, '\u007f');
      return;
    }

    if (event.key.length === 1) {
      onWrite(id, event.key);
    }
  }

  return (
    <section className="embedded-card embedded-terminal" aria-label={title}>
      <div className="embedded-card-bar">
        <div>
          <div className="embedded-title">{title}</div>
          <div className="embedded-subtitle">{cwd} · {status}</div>
        </div>
        <div className="terminal-actions">
          <button className="terminal-action" type="button" onClick={() => onKill(id)} disabled={status !== 'running'}>Kill</button>
          <button className="terminal-action" type="button" onClick={() => onClose(id)}>Close</button>
        </div>
      </div>
      {canMountXterm ? (
        <div
          ref={containerRef}
          className="terminal-host"
          role="textbox"
          aria-label={`Interactive terminal for ${title}`}
          aria-multiline="true"
          tabIndex={0}
          onFocus={() => terminalRef.current?.focus()}
          onClick={() => terminalRef.current?.focus()}
        />
      ) : (
        <textarea
          className="terminal-host terminal-host-fallback"
          aria-label={`Interactive terminal for ${title}`}
          value={output || '[terminal ready]'}
          onChange={() => undefined}
          onKeyDown={handleFallbackKeyDown}
          disabled={status !== 'running'}
        />
      )}
    </section>
  );
}
