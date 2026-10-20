import type { LaunchOptions } from 'playwright-core';
export const BROWSER_ENGINE: 'camoufox';
export const BROWSER_DRIVER_VERSION: '1.62.0';
export function camoufoxLaunchOptions(): Promise<LaunchOptions>;
