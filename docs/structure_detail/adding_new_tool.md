# Adding a New Tool

Follow these steps and your tool will be registered cleanly in the system. Settings
and tool metadata are manifest-backed, but route page loading is still an explicit
app-router step.

---

## Step-by-Step Checklist

### 1. Create Tool Structure

Create your tool directory with a page entrypoint and whatever local components/hooks it needs:

```
src/tools/my-new-tool/
├── pages/
│   └── MyNewToolPage.tsx      # Primary UI component
├── components/                 # Tool-specific widgets
├── hooks/                      # Custom hooks (optional)
```

If the tool owns its own persisted settings contract, keep the settings object in
`src/tools/my-new-tool/settings.ts`. If the settings/defaults are intentionally
shared across tools, keep that canonical object in a shared module and import it
from the tool registration points below.

### 2. Define Tool Settings

Define one canonical settings object for the tool:

```typescript
// src/tools/my-new-tool/settings.ts (or a shared module if the settings are reused)
export const myNewToolSettings = {
  id: 'my-new-tool',
  scope: ['project'] as const,     // Can be: ['user'], ['project'], ['shot'], or combinations
  defaults: {
    // Your strongly-typed default values
    enableFeatureX: true,
    maxItems: 10,
    apiEndpoint: 'https://api.example.com',
  },
};

// TypeScript type for your settings
export type MyNewToolSettings = typeof myNewToolSettings.defaults;
```

### 3. Register in Tool Metadata

Register the same settings object in `src/tools/index.ts`, then add the runtime
tool metadata in `src/shared/lib/tooling/toolManifest.ts`. That shared tooling
manifest is the canonical source for tool identity, path, environment availability,
and Tools-pane visibility metadata:

```typescript
// src/tools/index.ts

// 1. Import the canonical settings object
import { myNewToolSettings } from './my-new-tool/settings';

// 2. Add it to the settings manifest
toolsManifest.push(myNewToolSettings);
```

```typescript
// src/shared/lib/tooling/toolManifest.ts

// 3. Add runtime/UI metadata
toolRuntimeManifest.push({
  id: myNewToolSettings.id,
  name: 'My New Tool',               // Display name
  path: '/tools/my-new-tool',        // Route path
  icon: SomeIcon,                    // Lucide icon component
  description: 'Tool description',   // Optional
  paneSection: 'main',               // or 'assistant'
  visibleInToolsPane: true,          // false for hidden/internal tools
});
```

`toolsUIManifest` is derived from `toolRuntimeManifest`, so visible tools should
not be added in two places.

Also add the defaults to `src/tooling/toolDefaultsRegistry.ts` so the tool can
participate in the shared defaults/bootstrap flow:

```typescript
import { myNewToolSettings } from '@/tools/my-new-tool/settings';

const TOOL_SETTINGS_WITH_DEFAULTS = [
  // ...
  myNewToolSettings,
];
```

### 4. Add Route

Register the route in the app router:

```typescript
// src/app/routes.tsx

// Import your page component
import { MyNewToolPage } from '@/tools/my-new-tool/pages/MyNewToolPage';

// Add to routes array
{
  path: '/tools/my-new-tool',
  element: <MyNewToolPage />
}
```

### 5. Implement Tool UI

Create your main page component using `useAutoSaveSettings`, and pass the same
canonical settings object's `id` and `defaults` into the hook:

```typescript
// src/tools/my-new-tool/pages/MyNewToolPage.tsx
import { useAutoSaveSettings } from '@/shared/settings/hooks/useAutoSaveSettings';
import { useProject } from '@/shared/contexts/ProjectContext';
import { myNewToolSettings, MyNewToolSettings } from '../settings';

export function MyNewToolPage() {
  const { selectedProjectId } = useProject();

  const { settings, updateField, updateFields, status } = useAutoSaveSettings<MyNewToolSettings>({
    toolId: myNewToolSettings.id,
    projectId: selectedProjectId,
    scope: 'project',
    defaults: myNewToolSettings.defaults,
    enabled: !!selectedProjectId,
  });

  if (status !== 'ready') {
    return <div>Loading settings...</div>;
  }

  return (
    <div className="container mx-auto p-6">
      <h1>My New Tool</h1>
      {/* Read settings */}
      <p>Feature X: {settings.enableFeatureX ? 'enabled' : 'disabled'}</p>

      {/* Update single field */}
      <button onClick={() => updateField('enableFeatureX', !settings.enableFeatureX)}>
        Toggle Feature X
      </button>

      {/* Update multiple fields */}
      <button onClick={() => updateFields({ maxItems: 20, apiEndpoint: 'new-url' })}>
        Update Multiple
      </button>
    </div>
  );
}
```

> **See also:** [Settings System](./settings_system.md) for full API docs and alternative hooks (`usePersistentToolState` for binding existing useState, `useToolSettings` for low-level access).

### 6. Backend logic

There is no cloud backend in this repo (the Supabase `supabase/` directory and Edge Functions were removed 2026-10-18, tag `pre-cloud-removal`). Server-side work goes through the Runtime: admit a task with `createTask` (`src/shared/lib/taskCreation/createTask.ts`, see [Task Creation](./unified_task_creation.md)). A tool that needs an online account calls `requireCloudBackend(feature)` from `src/shared/lib/cloudBackend.ts` and catches `CloudBackendUnavailableError` once at the page to show one plain line.

---

## Notes

- **Settings scope** -- choose based on where settings should persist:
  - `user`: Global user preferences
  - `project`: Project-specific config
  - `shot`: Shot-level overrides
- **State management** -- use `markAsInteracted()` after programmatic changes to ensure saves trigger correctly.

---

**Related Docs:**
[Contributor entry point](../../AGENTS.md) | [Settings System](./settings_system.md) | [Design Guidelines](./design_motion_guidelines.md)
