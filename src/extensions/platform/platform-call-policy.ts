import type { EntryRole, PlatformPermission } from '@boaa/extension-contracts/platform-package';

interface CallPolicy {
  readonly roles: readonly EntryRole[];
  readonly permission?: PlatformPermission;
}

// Only role/method policy lives here. Session fencing, persisted grants and
// method-specific installation requirements remain authoritative in the store.
const policies: Readonly<Record<string, CallPolicy>> = {
  'http.request': { roles: ['controller', 'ui'], permission: 'http.request' },
  'http.cancel': { roles: ['controller'], permission: 'http.request' },
  'settings.get': { roles: ['controller', 'ui'], permission: 'settings.own' },
  'settings.watch': { roles: ['ui'], permission: 'settings.own' },
  'settings.unwatch': { roles: ['ui'], permission: 'settings.own' },
  'settings.set': { roles: ['controller', 'ui'], permission: 'settings.own' },
  'settings.register': { roles: ['controller', 'ui'], permission: 'settings.own' },
  'jobs.sleep': { roles: ['controller'] },
  'tasks.run': { roles: ['controller'] },
  'reader.decorations.changed': { roles: ['controller'], permission: 'reader.decorations' },
  'reader.state.get': { roles: ['controller'], permission: 'reader.state' },
  'reader.annotations.list': { roles: ['controller'], permission: 'reader.annotations.read' },
  'reader.annotations.create': { roles: ['controller'], permission: 'reader.annotations.write' },
  'reader.annotations.update': { roles: ['controller'], permission: 'reader.annotations.write' },
  'reader.annotations.delete': { roles: ['controller'], permission: 'reader.annotations.write' },
  'reader.content.read': { roles: ['controller'], permission: 'reader.content.book' },
  'reader.content.search': { roles: ['controller'], permission: 'reader.content.book' },
  'reader.auto.start': { roles: ['controller'], permission: 'reader.control' },
  'reader.auto.update': { roles: ['controller'], permission: 'reader.control' },
  'reader.auto.stop': { roles: ['controller'], permission: 'reader.control' },
  'controller.call': { roles: ['ui'], permission: 'ui.render' },
};

export function platformCallPolicy(method: string): CallPolicy | undefined {
  return Object.prototype.hasOwnProperty.call(policies, method) ? policies[method] : undefined;
}
