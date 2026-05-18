import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

const originalConsoleError = console.error.bind(console);

vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
  const message = args.map((arg) => String(arg)).join(' ');

  if (message.includes('Warning: An update to') && message.includes('inside a test was not wrapped in act')) {
    return;
  }

  originalConsoleError(...args);
});

if (typeof HTMLCanvasElement !== 'undefined') {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => null)
  });
}
