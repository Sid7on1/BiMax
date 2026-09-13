import { useSyncExternalStore } from 'react';
import { EngineDomain } from './engine.store';

export function useEngineDomain<T extends object>(domain: EngineDomain<T>): T {
  return useSyncExternalStore(domain.subscribe, domain.getSnapshot);
}
