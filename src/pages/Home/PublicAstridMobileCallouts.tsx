import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { PublicAstridAudience } from './publicAstridMotion';

interface Feature {
  id: string;
  title: string;
  body: string;
  target: string;
  position: 'top-left' | 'top-right' | 'top' | 'bottom-left' | 'bottom-right' | 'bottom';
}

// Mobile has its own short editorial copy, not a scaled-down desktop annotation.
const FEATURES: Record<PublicAstridAudience, readonly Feature[]> = {
  app: [
    { id: 'timeline', title: 'Edit with your agents', body: 'Make precise edits by hand, or work with your agent on more complex changes.', target: '.astrid-timeline-surface', position: 'top-left' },
    { id: 'effects', title: 'Live-code effects', body: 'Describe the look you want. Your agent edits the code, and you see the result in the editor.', target: '.astrid-inspector-surface', position: 'top-right' },
    { id: 'models', title: 'Your agent runs local models', body: 'Your agent figures out how to get your local models to do the job, then runs them on your machine.', target: '[data-astrid-agent-launcher]', position: 'bottom' },
  ],
  agent: [
    { id: 'tools', title: 'Connected to open-source tools', body: 'Work across these tools, and add integrations of your own.', target: '.astrid-chat-surface', position: 'top' },
    { id: 'workflows', title: 'Reusable workflows', body: 'Build on community-made plans and tools instead of starting every creative task from scratch.', target: '.astrid-chat-surface', position: 'bottom-left' },
    { id: 'community', title: 'Shared intelligence', body: 'Discoveries from the community help inform your agent’s creative decisions.', target: '.astrid-chat-surface', position: 'bottom-right' },
  ],
};

const INTEGRATIONS = [
  { id: 'comfyui', name: 'ComfyUI', href: 'https://github.com/Comfy-Org/ComfyUI' },
  { id: 'wan2gp', name: 'Wan2GP', href: 'https://github.com/deepbeepmeep/Wan2GP' },
  { id: 'hyperframes', name: 'HyperFrames', href: 'https://github.com/heygen-com/hyperframes' },
  { id: 'ai-toolkit', name: 'AI Toolkit', href: 'https://github.com/ostris/ai-toolkit' },
] as const;

interface Props {
  stageRef: RefObject<HTMLDivElement>;
  audience: PublicAstridAudience;
  active: boolean;
  reducedMotion: boolean;
}

/** Anchored, non-modal disclosures. CSS owns their geometry; opening never resizes the editor. */
export function PublicAstridMobileCallouts({ stageRef, audience, active, reducedMotion }: Props) {
  const instance = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggers = useRef<Record<string, HTMLButtonElement | null>>({});
  const [selection, setSelection] = useState<{ audience: PublicAstridAudience; id: string } | null>(null);
  // Hide an outgoing selection in the very first render, before effect cleanup.
  const expanded = active && selection?.audience === audience ? selection.id : null;
  const features = FEATURES[audience];

  useEffect(() => setSelection(null), [audience, active]);

  useEffect(() => {
    if (!expanded) return;
    const closeOutside = (event: Event) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setSelection(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (rootRef.current?.contains(document.activeElement)) triggers.current[expanded]?.focus({ preventScroll: true });
      setSelection(null);
    };
    document.addEventListener('pointerdown', closeOutside, true);
    document.addEventListener('focusin', closeOutside);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true);
      document.removeEventListener('focusin', closeOutside);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [expanded]);

  useLayoutEffect(() => {
    const feature = features.find(({ id }) => id === expanded);
    const target = feature && stageRef.current?.querySelector<HTMLElement>(feature.target);
    if (!target || !feature) return;
    target.setAttribute('data-astrid-feature-highlight', feature.id);
    return () => {
      if (target.getAttribute('data-astrid-feature-highlight') === feature.id) {
        target.removeAttribute('data-astrid-feature-highlight');
      }
    };
  }, [expanded, features, stageRef]);

  return (
    <div
      ref={rootRef}
      className="astrid-callouts astrid-mobile-callouts"
      data-reduced-motion={reducedMotion}
      aria-hidden={!active}
      {...(!active ? { inert: '' } : {})}
    >
      {features.map((feature) => {
        const open = expanded === feature.id;
        const triggerId = `${instance}-${feature.id}-trigger`;
        const detailId = `${instance}-${feature.id}-detail`;
        return (
          <article
            key={feature.id}
            className="astrid-callout astrid-mobile-feature"
            data-callout={feature.id}
            data-astrid-mobile-feature
            data-position={feature.position}
            data-open={open}
            // Reading a card must not activate the Agent backdrop's return-to-App action.
            onClick={(event) => event.stopPropagation()}
          >
            <h2>
              <button
                ref={(button) => { triggers.current[feature.id] = button; }}
                id={triggerId}
                type="button"
                className="astrid-mobile-feature-trigger"
                aria-expanded={open}
                aria-controls={detailId}
                onClick={() => setSelection(open ? null : { audience, id: feature.id })}
              >
                <span>{feature.title}</span>
                <span className="astrid-mobile-feature-plus" aria-hidden="true">+</span>
              </button>
            </h2>
            <div className="astrid-mobile-feature-reveal" aria-hidden={!open} {...(!open ? { inert: '' } : {})}>
              <div className="astrid-mobile-feature-clip">
                <div id={detailId} role="region" aria-labelledby={triggerId} className="astrid-mobile-feature-detail">
                  <p>{feature.body}</p>
                  {feature.id === 'tools' && (
                    <ul className="astrid-mobile-integrations" aria-label="Open-source integrations">
                      {INTEGRATIONS.map(({ id, name, href }) => (
                        <li key={id}>
                          <a href={href} target="_blank" rel="noopener noreferrer" tabIndex={open ? undefined : -1}>
                            <img src={`/integration-logos/${id}.webp`} alt="" width={24} height={24} decoding="async" />
                            <span>{name}</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
