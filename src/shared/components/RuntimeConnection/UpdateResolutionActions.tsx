import { Button } from '@/shared/components/ui/button.tsx';
import type { UpdateResolution } from '@/shared/lib/updates/resolveUpdate.ts';
import { CopyInstallCommand } from './CopyInstallCommand.tsx';

/** Render only the actions selected by K6; source and Pinokio must never fall through to installer commands. */
export function UpdateResolutionActions({ resolution }: { readonly resolution: UpdateResolution }) {
  const actions = [resolution.primary, resolution.secondary].filter((action) => action !== null);
  if (actions.length === 0) return null;

  const commandOptions = actions.some((action) => action.label === 'Copy for your agent' || action.label === 'Run it yourself');
  const route = actions.find((action) => action.destination === 'settings-updates');
  const installSpecific = actions.find((action) => action.label === 'Update in Pinokio' || action.label === 'update your checkouts');

  return <div className="space-y-2">
    {route && <Button type="button" variant="retro-secondary" size="retro-sm" data-destination={route.destination}>{route.label}</Button>}
    {installSpecific && <p className="text-sm font-medium">{installSpecific.label}</p>}
    {commandOptions && <CopyInstallCommand mode="update" />}
  </div>;
}
