import { describe, expect, it, vi } from 'vitest';
import { AstridElementOperationAdapter, createElementTimelineRoutes } from './element-adapter.ts';
import { buildAstridAgentElementContext } from './element-contract.ts';
import {getPinnedTimelineElementDescriptors} from './pinned-element-source';
import { ASTRID_EFFECT_CATALOG } from './astrid-element-catalog.ts';
import { configToRows, rowsToConfig } from '../lib/timeline-data.ts';
import type { TimelineConfig } from '../types/index.ts';

function context() {
  return buildAstridAgentElementContext({
    astridTransitions: [{ transitionId: 'cross-fade', packId:'rendering', provenance: 'astrid-catalog' }],
    effects: [{ id: 'glow', name: 'Glow', packId:'rendering', provenance:'astrid-catalog', is_public: true }],
    clips: [
      { id: 'a', trackId: 'picture', at: 0, duration: 2 },
      { id: 'b', trackId: 'picture', at: 2, duration: 2 },
    ],
  });
}

function documentPayload() {
  return {
    config: {
      output: { resolution: '1280x720', fps: 30, file: 'out.mp4' },
      clips: [
        { id: 'a', at: 0, track: 'picture', hold: 2 },
        { id: 'b', at: 2, track: 'picture', hold: 2 },
      ],
    },
    registry: {},
    config_version: 7,
  };
}

describe('Astrid element operation adapter', () => {
  it('keeps legacy bytes readable for migration but does not expose or execute source as admitted metadata',async()=>{
    const config={...documentPayload().config,clips:[{id:'saved',at:0,hold:2,track:'picture',clipType:'reveal',elementRef:{id:'reveal',kind:'effect' as const,revision:'draft-reveal'}}],app:{elements:{reveal:{kind:'effect',revision:'draft-reveal',source:'private JSX',schema:[]}}}};
    const saved=getPinnedTimelineElementDescriptors(config.clips,config.app);
    const save=vi.fn();const adapter=new AstridElementOperationAdapter({...context(),catalog:saved},{get:async()=>({...documentPayload(),config}),save},'astrid-intro');
    const result=await adapter.execute({name:'elements.describe',element_id:'reveal'});
    expect(result.element).toMatchObject({legacy:true,capabilities:{browserPreview:'blocked'}});
    expect(JSON.stringify(result)).not.toContain('private JSX');
    await expect(adapter.execute({name:'timeline.apply_element',project:'astrid-intro',timeline:'main',expected_version:7,placement:'overlay',element:{id:'reveal',kind:'effect',revision:'draft-reveal'}})).rejects.toThrow('not registered');
    expect(config.app.elements.reveal.source).toBe('private JSX');expect(save).not.toHaveBeenCalled();
  });

  it('updates only an admitted same-identity effect hold without moving neighbors or changing user params',async()=>{
    const element={id:'glow',kind:'effect' as const,packId:'rendering',revision:context().catalog.find(e=>e.id==='glow')!.revision};
    const payload={...documentPayload(),config:{...documentPayload().config,clips:[{id:'generated',at:0,track:'picture',hold:2,clipType:'glow',elementRef:element,params:{color:'#ff6b6b',seed:15}},documentPayload().config.clips[1]]}};
    const save=vi.fn(async(_id,input)=>({...payload,config:input.config,config_version:8}));
    const adapter=new AstridElementOperationAdapter(context(),{get:async()=>payload,save},'astrid-intro');
    const op={name:'timeline.update_element',project:'astrid-intro',timeline:'main',expected_version:7,clip_id:'generated',duration:6};
    const result=await adapter.execute(op);expect(result.config?.clips[0]).toEqual({...payload.config.clips[0],hold:6});expect(result.config?.clips[1]).toEqual(payload.config.clips[1]);
    for(const duration of [0,-1,NaN,Infinity])await expect(adapter.execute({...op,duration})).rejects.toThrow('finite positive');
    await expect(adapter.execute({...op,clip_id:'b'})).rejects.toThrow('admitted exact ref');
    Object.assign(payload.config.clips[0],{from:0});await expect(adapter.execute(op)).rejects.toThrow('without media trim');expect(save).toHaveBeenCalledTimes(1);
  });

  it('rejects all source-only draft lifecycle operations before any timeline write',async()=>{
    const get=vi.fn(),save=vi.fn();const adapter=new AstridElementOperationAdapter(context(),{get,save},'astrid-intro');
    for(const operation of [{name:'elements.create_draft',id:'reveal',kind:'effect',label:'Reveal',source:'export default()=>null'},
      {name:'elements.validate',draft_id:'reveal'},{name:'elements.publish',element_id:'reveal',revision:'draft-reveal'}]){
      await expect(adapter.execute(operation)).rejects.toThrow('project pack');
    }
    expect(get).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();
  });

  it('rejects retired editors before draft creation and never crosses the admitted timeline', async () => {
    let active = true;
    const assertAuthority = () => { if (!active) throw new Error('editor replaced'); };
    const get = vi.fn(async () => documentPayload()); const save = vi.fn();
    const adapter = new AstridElementOperationAdapter(context(), { get, save }, 'astrid-intro', { timelineId: 'main', assertAuthority });
    await expect(adapter.execute({ name: 'timeline.set_clip_fade', project: 'astrid-intro', timeline: 'other', expected_version: 7, clip_id: 'a', fade_in: 0.2 })).rejects.toThrow('does not match main');
    active = false;
    await expect(adapter.execute({ name: 'elements.create_draft', id: 'reveal', kind: 'effect', label: 'Reveal', source: 'export default function Reveal() { return <div />; }' })).rejects.toThrow('editor replaced');
    await expect(adapter.execute({ name: 'elements.list' })).rejects.toThrow('editor replaced');
    expect(get).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });

  it('uses the original head pair and bundle through the mounted save callback', async () => {
    const payload = documentPayload();
    const originalHead = { projectId: 'astrid-intro', timelineId: 'main', headRevisionId: 'head-7', headPublicationId: 'pub-7' };
    let latestHead = originalHead;
    const bundle = { schema_version: 1 as const, itemsBySchemaRef: {} };
    const save = vi.fn(async (_id, input) => {
      expect(input.expectedHead).toEqual(originalHead);
      expect(input.bundle).toEqual(bundle);
      if (JSON.stringify(latestHead) !== JSON.stringify(input.expectedHead)) throw new Error('head CAS conflict');
      return { ...payload, config: input.config, config_version: 8, head: { ...originalHead, headRevisionId: 'head-8', headPublicationId: 'pub-8' } };
    });
    const routes = createElementTimelineRoutes({ get: async () => ({ ...payload, head: latestHead, bundle }), save });
    const owner = new AstridElementOperationAdapter(context(), routes, 'astrid-intro', { timelineId: 'main', assertAuthority: () => {}, getHead: () => latestHead });
    const captured = owner.captureForTurn();
    const operation = { name: 'timeline.set_clip_fade', project: 'astrid-intro', timeline: 'main', expected_version: 7, clip_id: 'a', fade_in: 0.2 };
    await expect(captured.execute(operation)).resolves.toMatchObject({ config_version: 8 });
    latestHead = { ...originalHead, headRevisionId: 'external-head' };
    await expect(captured.execute(operation)).rejects.toThrow('captured timeline head changed');
    expect(save).toHaveBeenCalledTimes(1);
    await expect(routes.save('main', { config: payload.config, registry: {}, expectedVersion: 7, expectedHead: originalHead, bundle })).rejects.toThrow('head CAS conflict');
    const stale = owner.captureForTurn();
    latestHead = { ...latestHead, headPublicationId: 'same-revision-other-publication' };
    await expect(stale.execute(operation)).rejects.toThrow('captured timeline head changed');
  });

  it('applies and reloads an element through the active mounted save owner', async () => {
    const ownedContext = buildAstridAgentElementContext({ astridEffects: ASTRID_EFFECT_CATALOG });
    let payload = { ...documentPayload(), registry: { assets: { source: { type: 'image/png', file: 'managed:source' } } } };
    const save = vi.fn(async (_id, input) => {
      if (input.expectedVersion !== payload.config_version) throw new Error('stale timeline version');
      payload = { ...payload, config: input.config, registry: input.registry, config_version: 8 };
      return payload;
    });
    const routes = createElementTimelineRoutes({ get: async () => payload, save });
    const adapter = new AstridElementOperationAdapter(ownedContext, routes, 'astrid-intro');
    const entry = ownedContext.catalog.find(candidate => candidate.id === 'text-card' && candidate.packId === 'rendering')!;
    const element = { id: entry.id, kind: entry.kind, revision: entry.revision, packId: entry.packId };
    const operation = { name: 'timeline.apply_element', project: 'astrid-intro', timeline: 'main', expected_version: 7, clip_id: 'a', placement: 'overlay', element };
    const applied = await adapter.execute(operation);
    expect(applied.config_version).toBe(8);
    expect((await routes.get('main')).config).toEqual(expect.objectContaining({ clips: expect.arrayContaining([expect.objectContaining({ elementRef: element })]) }));
    await expect(adapter.execute(operation)).rejects.toThrow('Stale timeline version');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('preserves owner and revision through editor serialization and save/reload', async () => {
    const ownedContext = buildAstridAgentElementContext({ astridEffects: ASTRID_EFFECT_CATALOG });
    for (const packId of ['local', 'rendering']) {
      let payload = { ...documentPayload(), config: {
        ...documentPayload().config, tracks: [{ id: 'picture', kind: 'visual' }],
      } };
      const save = vi.fn(async (_ref, input) => {
        const config = input.config as TimelineConfig;
        const rows = configToRows(config);
        const serialized = rowsToConfig(rows.rows, rows.meta, config.output, rows.clipOrder, rows.tracks);
        payload = JSON.parse(JSON.stringify({ ...payload, config: serialized, config_version: 8 }));
        return payload;
      });
      const adapter = new AstridElementOperationAdapter(ownedContext, { get: vi.fn(async () => payload), save }, 'astrid-intro');
      const entry = ownedContext.catalog.find((candidate) => candidate.id === 'text-card' && candidate.packId === packId)!;
      const element = { id: entry.id, kind: entry.kind, revision: entry.revision, packId };
      await adapter.execute({ name: 'timeline.apply_element', project: 'astrid-intro', timeline: 'main', expected_version: 7, clip_id: 'a', placement: 'overlay', element });
      expect((payload.config as TimelineConfig).clips.find((clip) => clip.elementRef)?.elementRef).toEqual(element);
      const reloaded = new AstridElementOperationAdapter(ownedContext, { get: vi.fn(async () => payload), save }, 'astrid-intro');
      await expect(reloaded.execute({ name: 'timeline.apply_element', project: 'astrid-intro', timeline: 'main', expected_version: 8, clip_id: 'a', placement: 'overlay', element: { ...element, packId: 'unknown' } })).rejects.toThrow('not registered');
      await expect(reloaded.execute({ name: 'timeline.apply_element', project: 'astrid-intro', timeline: 'main', expected_version: 8, clip_id: 'a', placement: 'overlay', element: { ...element, packId: packId === 'local' ? 'rendering' : 'local' } })).rejects.toThrow('not registered');
      expect(save).toHaveBeenCalledTimes(1);
    }
  });
  it('applies a pinned transition through one expected-version CAS save', async () => {
    const payload = documentPayload();
    const save = vi.fn(async (_ref, input) => ({
      ...payload,
      config: input.config,
      registry: input.registry,
      config_version: 8,
    }));
    const adapter = new AstridElementOperationAdapter(context(), {
      get: vi.fn(async () => payload),
      save,
    }, 'astrid-intro');

    const result = await adapter.execute({
      name: 'timeline.apply_transition',
      project: 'astrid-intro',
      timeline: 'main',
      expected_version: 7,
      from_clip: 'a',
      to_clip: 'b',
      transition: {
        id: 'cross-fade',
        packId:'rendering',
        kind: 'transition',
        revision: context().catalog.find((entry) => entry.id === 'cross-fade')?.revision,
      },
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[1].expectedVersion).toBe(7);
    expect(result.config?.clips[1].elementRef?.id).toBe('cross-fade');
    expect(result.config?.clips[1].transition).toMatchObject({ type: 'cross-fade', duration: 8 / 30 });
  });

  it('uses visible hold duration when testing transition adjacency', async () => {
    const payload = documentPayload();
    payload.config.clips[0].hold = 4;
    (payload.config.clips[0] as Record<string, unknown>).speed = 2;
    const save = vi.fn(async (_ref, input) => ({
      ...payload,
      config: input.config,
      registry: input.registry,
      config_version: 8,
    }));
    const adapter = new AstridElementOperationAdapter(context(), {
      get: vi.fn(async () => payload),
      save,
    }, 'astrid-intro');

    await expect(adapter.execute({
      name: 'timeline.apply_transition',
      project: 'astrid-intro',
      timeline: 'main',
      expected_version: 7,
      from_clip: 'a',
      to_clip: 'b',
      transition: {
        id: 'cross-fade',
        packId:'rendering',
        kind: 'transition',
        revision: context().catalog.find((entry) => entry.id === 'cross-fade')?.revision,
      },
    })).resolves.toBeDefined();
  });

  it('preserves contributed effect arrays when setting legacy clip fades', async () => {
    const payload = documentPayload();
    const effects = [{ id: 'glow', params: { amount: 0.6 } }];
    (payload.config.clips[0] as Record<string, unknown>).effects = effects;
    const save = vi.fn(async (_ref, input) => ({
      ...payload,
      config: input.config,
      registry: input.registry,
      config_version: 8,
    }));
    const adapter = new AstridElementOperationAdapter(context(), {
      get: vi.fn(async () => payload),
      save,
    }, 'astrid-intro');

    await adapter.execute({
      name: 'timeline.set_clip_fade',
      project: 'astrid-intro',
      timeline: 'main',
      expected_version: 7,
      clip_id: 'a',
      fade_in: 0.5,
      fade_out: 0.25,
    });

    const savedClip = save.mock.calls[0]?.[1].config.clips[0];
    expect(savedClip.effects).toEqual(effects);
    expect(savedClip.entrance).toEqual({ type: 'fade', duration: 0.5 });
    expect(savedClip.exit).toEqual({ type: 'fade-out', duration: 0.25 });
  });

  it('preserves legacy drawable effects objects when setting clip fades', async () => {
    const payload = documentPayload();
    const effects = { fade_in: 0.1, blur: 0.25, vendorFlag: 3 };
    (payload.config.clips[0] as Record<string, unknown>).effects = effects;
    const save = vi.fn(async (_ref, input) => ({
      ...payload,
      config: input.config,
      registry: input.registry,
      config_version: 8,
    }));
    const adapter = new AstridElementOperationAdapter(context(), {
      get: vi.fn(async () => payload),
      save,
    }, 'astrid-intro');

    await adapter.execute({
      name: 'timeline.set_clip_fade',
      project: 'astrid-intro',
      timeline: 'main',
      expected_version: 7,
      clip_id: 'a',
      fade_in: 0.5,
      fade_out: 0.25,
    });

    const savedClip = save.mock.calls[0]?.[1].config.clips[0];
    expect(savedClip.effects).toEqual({ ...effects, fade_in: 0.5, fade_out: 0.25 });
    expect(savedClip.entrance).toEqual({ type: 'fade', duration: 0.5 });
    expect(savedClip.exit).toEqual({ type: 'fade-out', duration: 0.25 });
  });

  it('rejects an operation against a stale loaded document before writing', async () => {
    const payload = documentPayload();
    const save = vi.fn();
    const adapter = new AstridElementOperationAdapter(context(), {
      get: vi.fn(async () => ({ ...payload, config_version: 8 })),
      save,
    }, 'astrid-intro');

    await expect(adapter.execute({
      name: 'timeline.set_clip_fade',
      project: 'astrid-intro',
      timeline: 'main',
      expected_version: 7,
      clip_id: 'a',
      fade_in: 0.5,
    })).rejects.toThrow('Stale timeline version');
    expect(save).not.toHaveBeenCalled();
  });

  it('never attaches a source-only registry fallback for an unadmitted exact-looking ref',async()=>{
    const config={...documentPayload().config,app:{elements:{glow:{kind:'effect',revision:'invented',source:'export default()=>null'}}}};
    const save=vi.fn();const adapter=new AstridElementOperationAdapter(context(),{get:async()=>({...documentPayload(),config}),save},'astrid-intro');
    await expect(adapter.execute({name:'timeline.apply_element',project:'astrid-intro',timeline:'main',expected_version:7,placement:'overlay',element:{id:'glow',packId:'rendering',kind:'effect',revision:'invented'}})).rejects.toThrow('not registered');
    expect(save).not.toHaveBeenCalled();expect(config.app.elements.glow.source).toBe('export default()=>null');
  });

  it('also rejects broken source explicitly instead of offering the retired inline validator',async()=>{
    const adapter=new AstridElementOperationAdapter(context(),{get:vi.fn(),save:vi.fn()},'astrid-intro');
    await expect(adapter.execute({name:'elements.create_draft',id:'broken',kind:'effect',label:'Broken',source:'export default ('})).rejects.toThrow('Embedded source authoring is not supported');
  });

  it('creates a deterministic overlay clip when placement is overlay', async () => {
    const payload = documentPayload();
    const save = vi.fn(async (_ref, input) => ({
      ...payload,
      config: input.config,
      registry: input.registry,
      config_version: 8,
    }));
    const adapter = new AstridElementOperationAdapter(context(), { get: vi.fn(async () => payload), save }, 'astrid-intro');
    const element = context().catalog.find((entry) => entry.id === 'glow');
    const result = await adapter.execute({
      name: 'timeline.apply_element',
      project: 'astrid-intro',
      timeline: 'main',
      expected_version: 7,
      clip_id: 'a',
      at: 0.5,
      duration: 1.25,
      placement: 'overlay',
      element: { id: 'glow', kind: 'effect',packId:'rendering', revision: element?.revision },
    });
    expect(result.config?.clips).toContainEqual(expect.objectContaining({
      id: 'element-glow-500',
      at: 0.5,
      clipType: 'glow',
      hold: 1.25,
      elementRef: { id: 'glow', kind: 'effect',packId:'rendering', revision: element?.revision },
    }));
  });

  it('projects an animation application into the backend animation reference field', async () => {
    const payload = documentPayload();
    const save = vi.fn(async (_ref, input) => ({
      ...payload,
      config: input.config,
      registry: input.registry,
      config_version: 8,
    }));
    const animationContext = buildAstridAgentElementContext({
      effects: [{ id: 'glow', name: 'Glow', packId:'rendering', provenance:'astrid-catalog', is_public: true }],
      astridTransitions: [{ transitionId: 'cross-fade', packId:'rendering', provenance: 'astrid-catalog' }],
      astridAnimations: [{ id: 'fade-up', name: 'Fade Up',packId:'rendering', revision: 'rev-animation', provenance: 'astrid-catalog' }],
      clips: [
        { id: 'a', trackId: 'picture', at: 0, duration: 2 },
        { id: 'b', trackId: 'picture', at: 2, duration: 2 },
      ],
    });
    const adapter = new AstridElementOperationAdapter(animationContext, { get: vi.fn(async () => payload), save }, 'astrid-intro');
    const result = await adapter.execute({
      name: 'timeline.apply_element',
      project: 'astrid-intro',
      timeline: 'main',
      expected_version: 7,
      clip_id: 'a',
      placement: 'clip',
      element: { id: 'fade-up', kind: 'animation',packId:'rendering', revision: 'rev-animation' },
    });

    expect(result.config?.clips[0]).toMatchObject({
      elementRef: { id: 'fade-up', kind: 'animation',packId:'rendering', revision: 'rev-animation' },
      entrance: { type: 'fade-up', duration: 0.4 },
    });
  });

  it('rejects an explicit non-adjacent transition target', async () => {
    const payload = documentPayload();
    const adapter = new AstridElementOperationAdapter(context(), {
      get: vi.fn(async () => payload),
      save: vi.fn(),
    }, 'astrid-intro');
    await expect(adapter.execute({
      name: 'timeline.apply_transition',
      project: 'astrid-intro',
      timeline: 'main',
      expected_version: 7,
      from_clip: 'a',
      to_clip: 'a',
      transition: {
        id: 'cross-fade',
        packId:'rendering',
        kind: 'transition',
        revision: context().catalog.find((entry) => entry.id === 'cross-fade')?.revision,
      },
    })).rejects.toThrow('Transitions require adjacent clips');
  });
});


it('refuses a retired editor authority after a mounted read and before save', async () => {
  let admitted = true;
  const save = vi.fn();
  const get = vi.fn(async () => { admitted = false; return documentPayload(); });
  const routes = createElementTimelineRoutes({ get, save }, () => {
    if (!admitted) throw new Error('captured editor retired');
  });
  await expect(routes.get('owned-timeline')).rejects.toThrow('captured editor retired');
  expect(get).toHaveBeenCalledTimes(1);
  await expect(routes.save('owned-timeline', {config: {clips: []}, registry: {}, expectedVersion: 3})).rejects.toThrow('captured editor retired');
  expect(save).not.toHaveBeenCalled();
});
