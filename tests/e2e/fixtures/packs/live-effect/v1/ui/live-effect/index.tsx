import React from 'react';
import { defineExtension } from '@astrid/editor-sdk';
import manifest from './extension.json';

// The visible marker the PK-14 journey looks for in the open editor's preview.
export const LIVE_EFFECT_MARKER = 'LIVE-EFFECT-V1';

export default defineExtension({
  manifest,
  activate(ctx) {
    ctx.effects.registerComponent('live-effect', ({ children }: { children?: React.ReactNode }) =>
      React.createElement('div', { 'data-testid': 'live-effect', 'data-revision': 'v1' },
        React.createElement('span', { 'data-testid': 'live-effect-marker' }, LIVE_EFFECT_MARKER), children));
  },
});
