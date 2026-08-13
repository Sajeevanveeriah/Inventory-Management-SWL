import { createDesktopPlatformService, type InvokeFunction } from './desktop';
import type { PlatformKind, PlatformService } from './contracts';
import { createWebPlatformService } from './web';

export function detectPlatformKind(
  location: Pick<Location, 'protocol' | 'hostname'>,
): PlatformKind {
  return location.protocol === 'tauri:' || location.hostname === 'tauri.localhost'
    ? 'desktop'
    : 'web';
}

export function createPlatformService(options?: {
  location?: Pick<Location, 'protocol' | 'hostname'>;
  invoke?: InvokeFunction;
  staticDemo?: boolean;
}): PlatformService {
  const location = options?.location ?? window.location;
  const staticDemo = options?.staticDemo ?? import.meta.env.VITE_STATIC_DEMO === 'true';
  return detectPlatformKind(location) === 'desktop'
    ? createDesktopPlatformService(options?.invoke)
    : createWebPlatformService(undefined, {
        sessionOnly: staticDemo,
      });
}

export type * from './contracts';
