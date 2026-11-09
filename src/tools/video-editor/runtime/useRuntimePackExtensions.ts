import { useCallback, useEffect, useState } from 'react';
import type { AstridExtension } from '@astrid/editor-sdk';
import { createIndexedDBExtensionStateRepository } from './extensionStateRepositoryIndexedDB';
import { generateIntegrityHash } from './extensionIntegrity';
import type { ExtensionPackRecord } from './extensionStateRepository';
import { useExtensionLoaderWiring } from './useExtensionLoaderWiring';
import { runtimeApiBase } from '@/integrations/runtime/connection';

/** Runtime owns installed presence and canonical manifests; IndexedDB is a carrier. */
export function useRuntimePackExtensions(directExtensions: readonly AstridExtension[] | undefined, refreshIntervalMs: number) {
  const [repository, setRepository] = useState<ReturnType<typeof createIndexedDBExtensionStateRepository> | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [transportError, setTransportError] = useState<Error | null>(null);
  useEffect(() => {
    const repo = createIndexedDBExtensionStateRepository();
    let stopped = false;
    let running = false;
    let last = '';
    async function refresh() {
      if (running || stopped) return;
      running = true;
      try {
        await repo.initialize();
        const response = await fetch(`${runtimeApiBase()}/packs/inventory`, { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok || response.redirected) throw new Error('Runtime installed pack inventory is unavailable');
        const inventory = await response.json();
        if (inventory.version !== 1 || !Number.isSafeInteger(inventory.revision) || inventory.revision < 0 || !Array.isArray(inventory.packs)) {
          throw new Error('Runtime installed pack inventory is malformed');
        }
        const fingerprint = JSON.stringify(inventory);
        if (fingerprint !== last) {
          const ids = new Set<string>();
          for (const admission of inventory.packs) {
            const artifact = admission.artifactManifest;
            const manifest = artifact?.extensionManifest;
            if (!manifest || typeof manifest.id !== 'string' || ids.has(manifest.id)) throw new Error('Runtime artifact manifest identity is missing or duplicated');
            ids.add(manifest.id);
            const content = JSON.stringify(artifact);
            const ref = `runtime:${admission.packId}:${admission.digest}`;
            await repo.putBundleContent(ref, content);
            const record: ExtensionPackRecord = { extensionId: manifest.id, version: manifest.version,
              apiVersion: manifest.apiVersion, integrity: await generateIntegrityHash(content),
              installedAt: new Date().toISOString(), bundleContentRef: ref,
              publisher: manifest.publisher, license: manifest.license, manifestSnapshot: manifest };
            if (await repo.getPackRecord(manifest.id)) await repo.updatePackRecord(manifest.id, record);
            else await repo.putPackRecord(record);
          }
          for (const record of await repo.getAllPackRecords()) {
            if (record.bundleContentRef.startsWith('runtime:') && !ids.has(record.extensionId)) await repo.deletePackRecord(record.extensionId);
          }
          if (!stopped) { last = fingerprint; setRepository(repo); setRefreshKey((key) => key + 1); }
        }
        if (!stopped) setTransportError(null);
      } catch (error) {
        if (!stopped) setTransportError(error instanceof Error ? error : new Error(String(error)));
      } finally { running = false; }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), refreshIntervalMs);
    const onRefresh = () => { last = ''; setRefreshKey((key) => key + 1); void refresh(); };
    window.addEventListener('focus', onRefresh);
    window.addEventListener('astrid:pack-inventory-changed', onRefresh);
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener('focus', onRefresh); window.removeEventListener('astrid:pack-inventory-changed', onRefresh); };
  }, [refreshIntervalMs]);
  const triggerExtensionRefresh = useCallback(() => {
    window.dispatchEvent(new Event('astrid:pack-inventory-changed'));
  }, []);
  const wiring = useExtensionLoaderWiring({ directExtensions, repository, bundleStore: repository, refreshKey });
  return { ...wiring, repository, triggerExtensionRefresh, error: transportError ?? wiring.error };
}
