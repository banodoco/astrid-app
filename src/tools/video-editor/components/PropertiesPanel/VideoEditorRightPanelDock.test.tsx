import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/shared/components/ui/dialog';
import { ExtensionManager } from '@/tools/video-editor/components/ExtensionManager';
import { defaultPreferences, type EditorPreferences } from '../../hooks/useEditorPreferences';
import { VideoEditorRightPanelDock } from './VideoEditorRightPanelDock';
import { VideoEditorPanelDisplayControl } from './VideoEditorPanelDisplayControl';
const state = vi.hoisted(() => ({ panels: [] as Array<{extensionId:string;id:string;label:string}>, timelineData: {} as object | null, preferences: {} as EditorPreferences, selection: {} as {selectedClipIds?:Set<string>;selectedTrackId?:string|null;inspectorTarget?:{kind:string}|null}, update: (_next: EditorPreferences | ((current: EditorPreferences) => EditorPreferences)) => {}, inventory: null as null | Array<{extensionId:string; packageSource:string; packageState:string; packageMetadata?:{label:string}}>, extensions: [] as Array<{manifest:{id:string;label?:string;description?:string;contributions?:Array<Record<string,unknown>>}}>, commandRegistry: { executeCommand: vi.fn(async (_commandId: string) => {}) } as { executeCommand: (commandId: string) => Promise<unknown> } | null, toggle: vi.fn(async () => {}), refresh: vi.fn() }));
const panelKey = 'haus.astrid.transcript-lane:transcript-lane-panel';
vi.mock('./PropertiesPanel', () => ({ PropertiesPanel: () => <div>Inspector content</div> }));
vi.mock('./VideoEditorAssetPanelSurface', () => ({ VideoEditorAssetPanelSurface: (props: {activePanelKey: string | null; settingsByPanelKey: Record<string,{open:boolean;onOpenChange:(value:boolean)=>void}>; fullscreenPanelKey?: string | null; onFullscreenPanelKeyChange?: (key: string | null) => void}) => {
  const [draft, setDraft] = useState('');
  return <div hidden={!props.activePanelKey}><textarea aria-label="Retained draft" value={draft} onChange={(event) => setDraft(event.target.value)} /><button aria-label="Transcript settings" onClick={() => props.settingsByPanelKey[panelKey].onOpenChange(true)}>Settings</button><span>{props.settingsByPanelKey[panelKey]?.open ? 'Tool settings open' : 'Tool reading view'}</span><span data-testid="fullscreen-key">{props.fullscreenPanelKey ?? 'none'}</span><button type="button" aria-label="Surface dock all" onClick={() => props.onFullscreenPanelKeyChange?.(null)}>Dock all</button></div>;
} }));
vi.mock('../../components/ExtensionManager', () => ({ ExtensionManager: () => <div>Manager inventory</div> }));
vi.mock('../../runtime/useVideoEditorRenderContext', () => ({ useVideoEditorAssetPanels: () => state.panels }));
vi.mock('../../contexts/VideoEditorRuntimeContext', () => ({ useOptionalVideoEditorRuntime: () => ({ extensionRuntime: { extensions: state.extensions, packageStateInventory: state.inventory ?? [
  { extensionId: 'haus.astrid.transcript-lane', packageSource: 'direct', packageState: 'loaded', packageMetadata: {label:'Transcript'} },
  { extensionId: 'example', packageSource: 'installed', packageState: 'disabled-by-user', packageMetadata: {label:'Beat Cue'} },
] }, commandRegistry: state.commandRegistry, extensionStateRepository: { putEnablementState: state.toggle }, triggerExtensionRefresh: state.refresh }) }));
vi.mock('../../hooks/timelineStore', () => ({ useTimelineEditorData: () => ({ data: state.timelineData, preferences: state.preferences, ...state.selection }), useTimelineEditorOps: () => ({
  setSelectedRightPanelId: (id: string | null) => state.update((current) => ({ ...current, selectedRightPanelId: id, rightPanelTab: id ? id === 'host:properties' ? 'inspector' : 'extensions' : current.rightPanelTab, lastExtensionPanelId: id && id !== 'host:properties' ? id : current.lastExtensionPanelId })),
  setRightPanelLayoutSlot: (id: string, slot: 'compact' | 'dock') => state.update((current) => ({ ...current, rightPanelLayoutSlotsByPanelId: { ...current.rightPanelLayoutSlotsByPanelId, [id]: slot } })),
}) }));
function Harness({ initialPreferences = {}, selectedClipIds = [], inspectorTarget = null }: { initialPreferences?: Partial<EditorPreferences>; selectedClipIds?: string[]; inspectorTarget?: {kind:string}|null }) { const [preferences, update] = useState({ ...defaultPreferences, selectedRightPanelId: panelKey, lastExtensionPanelId: panelKey, rightPanelTab: 'extensions' as const, ...initialPreferences }); state.preferences = preferences; state.selection = { selectedClipIds: new Set(selectedClipIds), selectedTrackId: null, inspectorTarget }; state.update = update; return <div data-video-editor-instance="test"><button>Render</button><VideoEditorPanelDisplayControl visible={preferences.selectedRightPanelId === null} /><VideoEditorRightPanelDock leftPanelPresent={false} compactDock /></div>; }
function SharedManagerHarness() {
  const [managerOpen, setManagerOpen] = useState(false);
  const [preferences, update] = useState({ ...defaultPreferences, selectedRightPanelId: panelKey, lastExtensionPanelId: panelKey, rightPanelTab: 'extensions' as const });
  state.preferences = preferences;
  state.selection = { selectedClipIds: new Set(), selectedTrackId: null, inspectorTarget: null };
  state.update = update;
  return <>
    <VideoEditorRightPanelDock leftPanelPresent={false} compactDock onOpenExtensionManager={() => setManagerOpen(true)} extensionManagerOpen={managerOpen} />
    <Dialog open={managerOpen} onOpenChange={setManagerOpen}>
      <DialogContent><DialogHeader><DialogTitle>Extensions</DialogTitle></DialogHeader><ExtensionManager /></DialogContent>
    </Dialog>
  </>;
}
beforeEach(() => {
  vi.clearAllMocks();
  state.panels = [{ extensionId: 'haus.astrid.transcript-lane', id: 'transcript-lane-panel', label: 'Transcript' }, { extensionId: 'example', id: 'beat', label: 'Beat Cue' }];
  state.timelineData = {};
  state.inventory = null;
  state.extensions = [
    { manifest: { id: 'haus.astrid.threejs-live-editor', label: 'Three.js Live Editor' } },
    { manifest: { id: 'haus.astrid.transcript-lane', label: 'Transcript' } },
  ];
}); afterEach(cleanup);
it('mounts extension panels only once the timeline has arrived, so they never show a false empty state', () => {
  state.timelineData = null;
  const view = render(<Harness />);
  expect(screen.queryByRole('textbox', { name: 'Retained draft' })).toBeNull();
  expect(screen.getByText('Inspector content')).toBeInTheDocument();
  state.timelineData = {};
  view.rerender(<Harness />);
  expect(screen.getByRole('textbox', { name: 'Retained draft' })).toBeInTheDocument();
});
it('separates Inspector/Extensions, limits tools to admitted panels and retains a draft across tabs and display changes', async () => {
  const user = userEvent.setup(); render(<Harness />);
  expect(screen.getByRole('tab', {name:'Extensions'})).toHaveAttribute('aria-selected','true');
  expect(screen.getByRole('tablist').parentElement).toContainElement(screen.getByRole('button', {name:'Panel display'}));
  const active = screen.getByRole('button', {name:'Displayed extension'});
  const manage = screen.getByRole('button', {name:'Manage extensions'});
  expect(active).toHaveTextContent('Display: Transcript');
  expect(manage).not.toHaveTextContent('Manage');
  expect(active).toHaveClass('flex-1'); expect(manage.parentElement).toHaveClass('shrink-0');
  expect(screen.getByRole('button', {name:'Displayed extension'}).parentElement).not.toContainElement(screen.getByRole('button', {name:'Panel display'}));
  const draft = screen.getByRole('textbox', {name:'Retained draft'}); fireEvent.change(draft, {target:{value:'Unsent draft'}});
  screen.getByRole('button',{name:'Displayed extension'}).focus(); await user.keyboard('{ArrowDown}');
  expect(screen.getByRole('menuitemradio',{name:/^Transcript/})).toBeTruthy(); expect(screen.getByRole('menuitemradio',{name:/^Beat Cue/})).toBeTruthy(); expect(screen.queryByRole('menuitemradio',{name:'Properties'})).toBeNull(); expect(screen.queryByRole('menuitemradio',{name:'Closed'})).toBeNull();
  await user.keyboard('{Escape}'); await user.click(screen.getByRole('tab',{name:'Inspector'})); expect(draft).not.toBeVisible();
  await user.click(screen.getByRole('tab',{name:'Extensions'})); expect(screen.getByRole('textbox',{name:'Retained draft'})).toBe(draft);
  screen.getByRole('button',{name:'Panel display'}).focus(); await user.keyboard('{ArrowDown}'); await user.click(screen.getByRole('menuitemradio',{name:'Compact'}));
  expect(screen.getByRole('region',{name:'Video editor right panel'})).toHaveAttribute('data-layout','compact');
  screen.getByRole('button',{name:'Panel display'}).focus(); await user.keyboard('{ArrowDown}'); await user.click(screen.getByRole('menuitemradio',{name:'Closed'}));
  expect(draft).not.toBeVisible(); expect(screen.getByRole('button',{name:'Panel display'})).toBeTruthy();
  expect(screen.queryByRole('tablist', {name:'Right panel surface'})).toBeNull();
  expect(screen.queryByRole('button', {name:'Manage extensions'})).toBeNull();
  screen.getByRole('button',{name:'Panel display'}).focus(); await user.keyboard('{ArrowDown}'); await user.click(screen.getByRole('menuitemradio',{name:'Compact'})); expect(screen.getByRole('textbox',{name:'Retained draft'})).toHaveValue('Unsent draft'); expect(screen.getByRole('region',{name:'Video editor right panel'})).toHaveAttribute('data-layout','compact');
});
it('opens the full extension manager directly and keeps tool settings through the retained seam', async () => {
  const user = userEvent.setup(); render(<Harness />);
  await user.click(screen.getByRole('button',{name:'Manage extensions'}));
  expect(screen.getByRole('dialog', { name: 'Extensions' })).toHaveTextContent('Manager inventory');
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button',{name:'Transcript settings'}));
  expect(screen.getByText('Tool settings open')).toBeTruthy();
});

it('delegates Manage to the host-shared manager dialog when the shared callback is supplied', async () => {
  const user = userEvent.setup(); render(<SharedManagerHarness />);
  await user.click(screen.getByRole('button', { name: 'Manage extensions' }));
  expect(screen.getAllByRole('dialog', { name: 'Extensions' })).toHaveLength(1);
  expect(screen.getByRole('dialog', { name: 'Extensions' })).toHaveTextContent('Manager inventory');
});

it('keeps the display menu open while the pointer moves to a mode and applies the click', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Panel display' }));
  const compact = await screen.findByRole('menuitemradio', { name: 'Compact' });
  // The parent can rerender while a menu is open (for example, when editor
  // selection or async extension state changes); the popup must retain identity.
  rerender(<Harness selectedClipIds={['clip-1']} />);
  expect(screen.getByRole('menuitemradio', { name: 'Compact' })).toBeVisible();
  await user.hover(compact);
  expect(screen.getByRole('menuitemradio', { name: 'Compact' })).toBeVisible();
  await user.click(compact);
  expect(screen.queryByRole('menuitemradio', { name: 'Compact' })).toBeNull();
  expect(screen.getByRole('region', { name: 'Video editor right panel' })).toHaveAttribute('data-layout', 'compact');
});

it('shows enabled extension names on hover/focus and click opens the full existing manager', async () => {
  const user = userEvent.setup(); render(<Harness />);
  const manage = screen.getByRole('button', { name: 'Manage extensions' });
  fireEvent.focus(manage);
  expect(screen.getByRole('tooltip')).toBeTruthy();
  fireEvent.keyDown(manage, { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).toBeNull();

  await user.hover(manage);
  expect(screen.getByRole('tooltip')).toHaveTextContent('Enabled extensions');
  expect(screen.getByRole('tooltip')).toHaveTextContent('Three.js Live Editor');
  expect(screen.getByRole('tooltip')).toHaveTextContent('Transcript');
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.unhover(manage);
  expect(screen.queryByRole('tooltip')).toBeNull();

  await user.hover(manage);
  expect(screen.getByRole('tooltip')).toBeTruthy();
  await user.click(manage);
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(screen.getByRole('dialog', { name: 'Extensions' })).toHaveTextContent('Manager inventory');
});

it('states honestly when no extension is currently enabled', async () => {
  state.inventory = [{ extensionId: 'example', packageSource: 'installed', packageState: 'disabled-by-user' }];
  state.extensions = [];
  state.panels = [];
  const user = userEvent.setup(); render(<Harness initialPreferences={{ selectedRightPanelId: 'host:extensions' }} />);
  await user.hover(screen.getByRole('button', { name: 'Manage extensions' }));
  expect(screen.getByRole('tooltip')).toHaveTextContent('No extensions are currently enabled.');
  expect(screen.getByRole('tooltip')).not.toHaveTextContent('Transcript');
});

it('keeps the shared display mode across both Inspector and Extensions switches', async () => {
  const user = userEvent.setup();
  render(<Harness initialPreferences={{
    selectedRightPanelId: panelKey,
    rightPanelTab: 'extensions',
    // A pre-shared saved extension mode migrates when the tab is changed.
    rightPanelLayoutSlotsByPanelId: { [panelKey]: 'compact' },
  }} />);
  const panel = screen.getByRole('region', { name: 'Video editor right panel' });
  expect(panel).toHaveAttribute('data-layout', 'compact');
  expect(panel).toHaveAttribute('data-placement', 'upper-right-grid');
  expect((panel as HTMLElement).style.gridRow).toBe('1 / -1');
  expect((panel as HTMLElement).style.gridColumn).toBe('2');

  await user.click(screen.getByRole('tab', { name: 'Inspector' }));
  expect(panel).toHaveAttribute('data-layout', 'compact');
  expect(state.preferences.rightPanelLayoutSlotsByPanelId['host:properties']).toBe('compact');
  await user.click(screen.getByRole('tab', { name: 'Extensions' }));
  expect(panel).toHaveAttribute('data-layout', 'compact');
  expect(panel).toHaveAttribute('data-placement', 'upper-right-grid');

  // A direct display-control change is the only action that changes mode.
  screen.getByRole('button', { name: 'Panel display' }).focus();
  await user.keyboard('{ArrowDown}');
  await user.click(screen.getByRole('menuitemradio', { name: 'Full-height' }));
  expect(panel).toHaveAttribute('data-layout', 'dock');
  expect(panel).toHaveAttribute('data-placement', 'full-height-grid');
  expect((panel as HTMLElement).style.gridRow).toBe('1 / -1');
  await user.click(screen.getByRole('tab', { name: 'Inspector' }));
  expect(panel).toHaveAttribute('data-layout', 'dock');
  expect(panel).toHaveAttribute('data-placement', 'full-height-grid');
  await user.click(screen.getByRole('tab', { name: 'Extensions' }));
  expect(panel).toHaveAttribute('data-layout', 'dock');

  // Explicitly selecting Compact while on Inspector carries across Extensions.
  await user.click(screen.getByRole('tab', { name: 'Inspector' }));
  screen.getByRole('button', { name: 'Panel display' }).focus();
  await user.keyboard('{ArrowDown}');
  await user.click(screen.getByRole('menuitemradio', { name: 'Compact' }));
  expect(panel).toHaveAttribute('data-layout', 'compact');
  await user.click(screen.getByRole('tab', { name: 'Extensions' }));
  expect(panel).toHaveAttribute('data-layout', 'compact');
  expect(panel).toHaveAttribute('data-placement', 'upper-right-grid');
});

it('hints only when Extensions is active and the current selection is inspectable', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Harness selectedClipIds={['media-clip-1']} />);
  expect(screen.getByRole('tab', { name: 'Inspector — selection available' })).toBeTruthy();
  expect(screen.getByTestId('inspector-selection-hint')).toBeTruthy();

  await user.click(screen.getByRole('tab', { name: 'Inspector — selection available' }));
  expect(screen.queryByTestId('inspector-selection-hint')).toBeNull();
  expect(screen.getByRole('tab', { name: 'Inspector' })).toHaveAttribute('aria-selected', 'true');

  await user.click(screen.getByRole('tab', { name: 'Extensions' }));
  expect(screen.getByRole('tab', { name: 'Inspector — selection available' })).toBeTruthy();

  rerender(<Harness inspectorTarget={{ kind: 'dataItem' }} />);
  expect(screen.getByRole('tab', { name: 'Inspector — selection available' })).toBeTruthy();
  rerender(<Harness />);
  expect(screen.getByRole('tab', { name: 'Inspector' })).toBeTruthy();
  expect(screen.queryByTestId('inspector-selection-hint')).toBeNull();
});


it.each(['compact', 'dock'] as const)('reopens the retained extension from only the toolbar icon in %s mode', async (mode) => {
  const user = userEvent.setup();
  render(<Harness initialPreferences={{ rightPanelLayoutSlotsByPanelId: { 'host:properties': mode } }} />);
  const draft = screen.getByRole('textbox', { name: 'Retained draft' });
  await user.type(draft, 'Keep this correction');
  screen.getByRole('button', { name: 'Panel display' }).focus();
  await user.keyboard('{ArrowDown}');
  await user.click(screen.getByRole('menuitemradio', { name: 'Closed' }));
  const closedControl = screen.getByRole('button', { name: 'Panel display' });
  await waitFor(() => expect(closedControl).toHaveFocus());
  expect(screen.getByRole('button', { name: 'Render' }).nextElementSibling).toBe(closedControl);
  expect(screen.getAllByRole('button', { name: 'Panel display' })).toHaveLength(1);
  expect(screen.queryByRole('tab', { name: 'Inspector' })).toBeNull();
  expect(screen.queryByRole('tab', { name: 'Extensions' })).toBeNull();
  expect(screen.getByTestId('video-editor-right-panel-dock')).toHaveAttribute('aria-hidden', 'true');
  expect(draft).toBeInTheDocument();
  expect(draft).not.toBeVisible();
  expect(state.preferences.rightPanelLayoutSlotsByPanelId['host:properties']).toBe(mode);
  closedControl.focus();
  await user.keyboard('{ArrowDown}');
  expect(screen.getByRole('menuitemradio', { name: 'Closed' })).toHaveAttribute('aria-checked', 'true');
  await user.click(screen.getByRole('menuitemradio', { name: mode === 'compact' ? 'Compact' : 'Full-height' }));
  expect(state.preferences.selectedRightPanelId).toBe(panelKey);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Panel display' })).toHaveFocus());
  expect(screen.getByRole('textbox', { name: 'Retained draft' })).toBe(draft);
  expect(draft).toHaveValue('Keep this correction');
  expect(screen.getByRole('region', { name: 'Video editor right panel' })).toHaveAttribute('data-layout', mode);
  expect(screen.getAllByRole('button', { name: 'Panel display' })).toHaveLength(1);
});

it('Extensions with no extension panels keeps the dock open and shows a calm empty state', async () => {
  const user = userEvent.setup(); state.panels = [];
  render(<Harness initialPreferences={{ selectedRightPanelId: 'host:properties', rightPanelTab: 'inspector' }} />);
  await user.click(screen.getByRole('tab', { name: 'Extensions' }));
  expect(state.preferences.selectedRightPanelId).not.toBeNull();
  expect(screen.getByTestId('video-editor-right-panel-dock')).toHaveAttribute('data-open', 'true');
  expect(screen.getByRole('tab', { name: 'Extensions' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByTestId('extensions-empty-state')).toBeVisible();
});
it('Extensions with extension panels keeps the dock open and shows the tool content', async () => {
  const user = userEvent.setup();
  render(<Harness initialPreferences={{ selectedRightPanelId: 'host:properties', rightPanelTab: 'inspector' }} />);
  await user.click(screen.getByRole('tab', { name: 'Extensions' }));
  expect(screen.getByTestId('video-editor-right-panel-dock')).toHaveAttribute('data-open', 'true');
  expect(screen.getByRole('textbox', { name: 'Retained draft' })).toBeVisible();
  expect(screen.queryByTestId('extensions-empty-state')).toBeNull();
});
it('disabling the selected extension keeps the dock open on the next panel, with Manage still reachable', () => {
  const view = render(<Harness />);
  expect(screen.getByRole('button', { name: 'Displayed extension' })).toHaveTextContent('Display: Transcript');
  // The Extension Manager disables Transcript: its panel unregisters while it is still the selected key.
  state.panels = [{ extensionId: 'example', id: 'beat', label: 'Beat Cue' }];
  view.rerender(<Harness />);
  expect(state.preferences.selectedRightPanelId).toBe(panelKey);
  expect(screen.getByTestId('video-editor-right-panel-dock')).toHaveAttribute('data-open', 'true');
  expect(screen.getByRole('button', { name: 'Displayed extension' })).toHaveTextContent('Display: Beat Cue');
  expect(screen.getByRole('button', { name: 'Manage extensions' })).toBeVisible();
  expect(screen.getAllByRole('button', { name: 'Panel display' })).toHaveLength(1);
  // Re-enabling it brings the remembered panel back.
  state.panels = [{ extensionId: 'haus.astrid.transcript-lane', id: 'transcript-lane-panel', label: 'Transcript' }, { extensionId: 'example', id: 'beat', label: 'Beat Cue' }];
  view.rerender(<Harness />);
  expect(screen.getByRole('button', { name: 'Displayed extension' })).toHaveTextContent('Display: Transcript');
});
it('reopening from Panel display with no extension panels parks on the Extensions host key instead of staying closed', async () => {
  const user = userEvent.setup(); state.panels = [];
  render(<Harness initialPreferences={{ selectedRightPanelId: null, lastExtensionPanelId: null, rightPanelTab: 'extensions' }} />);
  screen.getByRole('button', { name: 'Panel display' }).focus(); await user.keyboard('{ArrowDown}');
  await user.click(screen.getByRole('menuitemradio', { name: 'Full-height' }));
  expect(state.preferences.selectedRightPanelId).toBe('host:extensions');
  expect(screen.getByTestId('video-editor-right-panel-dock')).toHaveAttribute('data-open', 'true');
  expect(screen.getByTestId('extensions-empty-state')).toBeVisible();
});
it('on touch, the Extensions picker lists the Transcript panel', async () => {
  const user = userEvent.setup();
  function TouchHarness() {
    const [preferences, update] = useState({ ...defaultPreferences, selectedRightPanelId: 'host:properties', rightPanelTab: 'inspector' as const });
    state.preferences = preferences; state.selection = { selectedClipIds: new Set(), selectedTrackId: null, inspectorTarget: null }; state.update = update;
    return <VideoEditorRightPanelDock leftPanelPresent={false} touch />;
  }
  render(<TouchHarness />);
  await user.click(screen.getByRole('tab', { name: 'Extensions' }));
  await user.click(screen.getByRole('button', { name: 'Displayed extension' }));
  expect(await screen.findByRole('menuitemradio', { name: /^Transcript/ })).toBeInTheDocument();
});

it('puts the active extension full screen through the header control into the surface', async () => {
  const user = userEvent.setup(); render(<Harness />);
  expect(screen.getByTestId('fullscreen-key')).toHaveTextContent('none');
  const pop = screen.getByRole('button', { name: 'Full screen Transcript' });
  expect(pop).toHaveAttribute('aria-pressed', 'false');
  await user.click(pop);
  expect(screen.getByTestId('fullscreen-key')).toHaveTextContent(panelKey);
  expect(screen.getByRole('button', { name: 'Full screen Transcript' })).toHaveAttribute('aria-pressed', 'true');
});

it('returns focus to the Full screen button when full screen ends', async () => {
  const user = userEvent.setup(); render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Full screen Transcript' }));
  screen.getByRole('button', { name: 'Surface dock all' }).focus();
  await user.click(screen.getByRole('button', { name: 'Surface dock all' }));
  expect(screen.getByTestId('fullscreen-key')).toHaveTextContent('none');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Full screen Transcript' }));
});

it('keeps the full-screen panel across the Inspector tab switch', async () => {
  const user = userEvent.setup(); render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Full screen Transcript' }));
  await user.click(screen.getByRole('tab', { name: 'Inspector' }));
  expect(screen.getByTestId('fullscreen-key')).toHaveTextContent(panelKey);
  await user.click(screen.getByRole('tab', { name: 'Extensions' }));
  expect(screen.getByTestId('fullscreen-key')).toHaveTextContent(panelKey);
});

it('replaces the full-screen panel when a different tool goes full screen', async () => {
  const user = userEvent.setup(); render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Full screen Transcript' }));
  expect(screen.getByTestId('fullscreen-key')).toHaveTextContent(panelKey);
  screen.getByRole('button', { name: 'Displayed extension' }).focus();
  await user.keyboard('{ArrowDown}');
  await user.click(screen.getByRole('menuitemradio', { name: /^Beat Cue/ }));
  expect(screen.getByRole('button', { name: 'Full screen Beat Cue' })).toHaveAttribute('aria-pressed', 'false');
  await user.click(screen.getByRole('button', { name: 'Full screen Beat Cue' }));
  expect(screen.getByTestId('fullscreen-key')).toHaveTextContent('example:beat');
  expect(screen.getByTestId('fullscreen-key')).not.toHaveTextContent(panelKey);
});

it('lists an enabled extension without panels, shows its info view, and runs its command through the registry', async () => {
  const user = userEvent.setup();
  const executeCommand = vi.fn(async (_commandId: string) => {});
  state.commandRegistry = { executeCommand };
  state.extensions = [
    { manifest: { id: 'haus.astrid.transcript-lane', label: 'Transcript' } },
    { manifest: {
      id: 'haus.astrid.threejs-live-editor',
      label: 'Three.js Live Editor',
      description: 'Place live Three.js scenes on the timeline.',
      contributions: [
        { id: 'scene-clip', kind: 'clipType', label: 'Live Three.js Scene', clipTypeId: 'x' },
        { id: 'import', kind: 'command', command: 'haus.import', label: 'Import prepared scene' },
      ],
    } },
  ];
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Displayed extension' }));
  await user.click(await screen.findByRole('menuitemradio', { name: /^Three\.js Live Editor/ }));
  expect(state.preferences.selectedRightPanelId).toBe('host:extensions');
  expect(screen.getByRole('button', { name: 'Displayed extension' })).toHaveTextContent('Display: Three.js Live Editor');
  const info = screen.getByTestId('extension-info-view');
  expect(info).toHaveTextContent('Place live Three.js scenes on the timeline.');
  expect(info).toHaveTextContent('Live Three.js Scene clips');
  await user.click(screen.getByRole('button', { name: 'Import prepared scene' }));
  expect(executeCommand).toHaveBeenCalledWith('haus.import');
  expect(screen.queryByRole('button', { name: /^Full screen/ })).toBeNull();
});

it('shows a tablist of panels for an extension that owns more than one and selects the clicked panel', async () => {
  const user = userEvent.setup();
  state.panels = [
    { extensionId: 'haus.astrid.transcript-lane', id: 'transcript-lane-panel', label: 'Transcript' },
    { extensionId: 'haus.astrid.transcript-lane', id: 'transcript-notes', label: 'Notes' },
  ];
  render(<Harness />);
  const tablist = screen.getByRole('tablist', { name: 'Transcript panels' });
  expect(within(tablist).getByRole('tab', { name: 'Transcript' })).toBeInTheDocument();
  await user.click(within(tablist).getByRole('tab', { name: 'Notes' }));
  expect(state.preferences.selectedRightPanelId).toBe('haus.astrid.transcript-lane:transcript-notes');
  expect(within(tablist).getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true');
});

it('resolves a saved panel key to its extension label', () => {
  state.inventory = [
    { extensionId: 'haus.astrid.transcript-lane', packageSource: 'direct', packageState: 'loaded', packageMetadata: { label: 'Transcript' } },
    { extensionId: 'example', packageSource: 'installed', packageState: 'loaded', packageMetadata: { label: 'Beat Cue' } },
  ];
  state.panels = [
    { extensionId: 'haus.astrid.transcript-lane', id: 'transcript-lane-panel', label: 'Transcript' },
    { extensionId: 'example', id: 'beat', label: 'Beat cue controls' },
  ];
  render(<Harness initialPreferences={{ selectedRightPanelId: 'example:beat', lastExtensionPanelId: 'example:beat', rightPanelTab: 'extensions' }} />);
  expect(screen.getByRole('button', { name: 'Displayed extension' })).toHaveTextContent('Display: Beat Cue');
});

it('Manage is an icon-only button named Manage extensions, with a tooltip on hover and focus', async () => {
  const user = userEvent.setup(); render(<Harness />);
  const manage = screen.getByRole('button', { name: 'Manage extensions' });
  expect(manage).toHaveAttribute('aria-label', 'Manage extensions');
  expect((manage.textContent ?? '').trim()).toBe('');
  expect(manage.querySelector('svg')).not.toBeNull();

  await user.hover(manage);
  expect(screen.getByRole('tooltip')).toHaveTextContent('Manage extensions');
  await user.unhover(manage);
  expect(screen.queryByRole('tooltip')).toBeNull();

  fireEvent.focus(manage);
  expect(screen.getByRole('tooltip')).toHaveTextContent('Manage extensions');
});

it('the Displayed extension menu lists each extension panel names on a muted second line', async () => {
  const user = userEvent.setup();
  state.panels = [
    { extensionId: 'haus.astrid.transcript-lane', id: 'transcript-lane-panel', label: 'Transcript' },
    { extensionId: 'haus.astrid.transcript-lane', id: 'second', label: 'Second View' },
    { extensionId: 'example', id: 'beat', label: 'Beat Cue' },
  ];
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Displayed extension' }));
  const transcript = await screen.findByRole('menuitemradio', { name: /^Transcript/ });
  expect(within(transcript).getByTestId('extension-menu-panels')).toHaveTextContent('Transcript / Second View');
  expect(within(transcript).getByTestId('extension-menu-panels').className).toContain('text-muted-foreground');
  const beat = screen.getByRole('menuitemradio', { name: /^Beat Cue/ });
  expect(within(beat).getByTestId('extension-menu-panels')).toHaveTextContent(/^Beat Cue$/);
});

it('the Full screen button shows a tooltip on hover and focus, and clicking hides it and still goes full screen', async () => {
  const user = userEvent.setup(); render(<Harness />);
  const pop = screen.getByRole('button', { name: 'Full screen Transcript' });

  await user.hover(pop);
  expect(screen.getByRole('tooltip')).toHaveTextContent('Full screen Transcript');
  await user.unhover(pop);
  expect(screen.queryByRole('tooltip')).toBeNull();

  fireEvent.focus(pop);
  expect(screen.getByRole('tooltip')).toHaveTextContent('Full screen Transcript');
  fireEvent.blur(pop);
  expect(screen.queryByRole('tooltip')).toBeNull();

  await user.hover(pop);
  expect(screen.getByRole('tooltip')).toBeTruthy();
  await user.click(pop);
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(screen.getByTestId('fullscreen-key')).toHaveTextContent(panelKey);
});
it('shows the Compact layout while the editor tour runs, without writing it to the saved preferences', async () => {
  const { startEditorTour, exitEditorTour } = await import('@/shared/state/editorTourStore');
  render(<Harness initialPreferences={{ rightPanelLayoutSlotsByPanelId: { 'host:properties': 'dock' } }} />);
  const region = screen.getByRole('region', { name: 'Video editor right panel' });
  expect(region).toHaveAttribute('data-layout', 'dock');
  act(() => startEditorTour());
  expect(region).toHaveAttribute('data-layout', 'compact');
  expect(state.preferences.rightPanelLayoutSlotsByPanelId['host:properties']).toBe('dock');
  act(() => exitEditorTour());
  expect(region).toHaveAttribute('data-layout', 'dock');
});
