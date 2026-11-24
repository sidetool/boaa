import './platform/brand-storage-init';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { AuthenticatedApplication, startLocalApp } from './reader-application';
import { relayDropboxOAuthPopup } from './cloud-vault/dropbox-oauth';
import { SelfHostAccountGate } from './features/auth/SelfHostAccountGate';
import { detectPlatformRuntime } from './platform/runtime';
import { clearWebAppRuntimeState } from './platform/web-app-cache';

function registerWebAppServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  const platformRuntime = detectPlatformRuntime();
  const clearStaleRuntimeState = (deleteAllCaches: boolean, warning: string) => {
    window.addEventListener('load', () => {
      void Promise.all([
        navigator.serviceWorker.getRegistrations(),
        'caches' in window ? window.caches.keys() : Promise.resolve([]),
      ])
        .then(([registrations, cacheNames]) =>
          clearWebAppRuntimeState({
            registrations,
            cacheNames,
            deleteCache: (cacheName) => window.caches.delete(cacheName),
            deleteAllCaches,
          }),
        )
        .catch((error) => {
          console.warn(warning, error);
        });
    });
  };
  if (platformRuntime.hasTauri) {
    clearStaleRuntimeState(true, 'Stale desktop app cache cleanup failed.');
    return;
  }
  if (!import.meta.env.PROD) {
    clearStaleRuntimeState(false, 'Stale development app cache cleanup failed.');
    return;
  }
  if (!/^https?:$/.test(window.location.protocol)) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error) => {
      console.warn('PWA service worker registration failed.', error);
    });
  });
}

if (!relayDropboxOAuthPopup()) {
  registerWebAppServiceWorker();
  if (detectPlatformRuntime().kind === 'browser' && import.meta.env.VITE_READER_BACKEND === 'remote') {
    ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
      <React.StrictMode>
        <SelfHostAccountGate apiBaseUrl={(import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api'}>
          {(session) => <AuthenticatedApplication key={session.epoch} session={session} />}
        </SelfHostAccountGate>
      </React.StrictMode>,
    );
  } else {
    void startLocalApp();
  }
}
