import { useState } from 'react';
import { useTimelineChromeContext, useTimelineEditorData, useTimelineEditorOps } from '@/tools/video-editor/hooks/timelineStore';
import { useTimelineCommandsService } from '@/tools/video-editor/hooks/useTimelineCommandsService';
import { getClipEndSeconds, roundTimelineValue } from '@/tools/video-editor/lib/editor-utils';

export function FixtureControls() {
  const data = useTimelineEditorData();
  const ops = useTimelineEditorOps();
  const chrome = useTimelineChromeContext();
  const commands = useTimelineCommandsService();
  const [result, setResult] = useState('');
  const clip = data.resolvedConfig?.clips.find((candidate) => candidate.id === 'f2-transition-clip');
  const trimPort = ops.clipTrim;
  const nativeTrimReady = !!trimPort
    && typeof trimPort.capture === 'function'
    && typeof trimPort.finish === 'function'
    && typeof trimPort.submit === 'function';
  const trim = () => {
    if (!clip) return setResult(JSON.stringify({ ok: false, error: { code: 'clip_not_found' } }));
    const endTime = roundTimelineValue(getClipEndSeconds(clip) - 0.5);
    setResult(JSON.stringify(commands.trimClip({ clipId: clip.id, endTime })));
  };
  const recoveryOwners = chrome.commandSession?.state.recoverableOwners ?? [];
  return <main>
    <button type="button" data-testid="public-trim-trigger" disabled={!clip} onClick={trim}>Run public trim</button>
    {recoveryOwners.map((ownerId) => <button key={ownerId} type="button" data-testid="public-trim-recover" data-owner-id={ownerId} onClick={() => void chrome.commandSession?.recover(ownerId)}>Recover saved edits</button>)}
    <button type="button" data-testid="public-trim-undo" disabled={!chrome.canUndo} onClick={chrome.undo}>Undo</button>
    <output data-testid="public-trim-result">{result || JSON.stringify({ nativeClipTrimPortReady: nativeTrimReady })}</output>
    <output data-testid="public-trim-status">{chrome.commandSession?.state.status ?? chrome.saveStatus}</output>
  </main>;
}
