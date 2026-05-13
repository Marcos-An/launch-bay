import type { LaunchBayBridge } from './types';

declare global {
  interface Window {
    launchBay?: LaunchBayBridge;
  }
}

export {};
