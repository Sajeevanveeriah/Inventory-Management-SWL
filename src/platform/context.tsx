import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { PlatformService } from './contracts';
import { createPlatformService } from './index';

const PlatformContext = createContext<PlatformService | null>(null);

export function PlatformProvider({
  children,
  service,
}: {
  children: ReactNode;
  service?: PlatformService;
}) {
  const value = useMemo(() => service ?? createPlatformService(), [service]);
  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>;
}

export function usePlatform(): PlatformService {
  const service = useContext(PlatformContext);
  if (service === null) throw new Error('PlatformProvider is missing.');
  return service;
}
