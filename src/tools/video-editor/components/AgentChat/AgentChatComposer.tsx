import type { KeyboardEvent, Ref } from 'react';
import { Mic, Send, Square, X } from 'lucide-react';
import { Button } from '@/shared/components/ui/button.tsx';
import { CHAT_VOICE_ENABLED } from '@/tools/video-editor/hooks/chatVoice.ts';
import { EDITOR_TOUR_ANCHOR_ATTRIBUTE, EDITOR_TOUR_ANCHORS } from '@/tools/video-editor/tour/anchors.ts';

export interface AgentChatComposerVoice {
  isRecording: boolean;
  onToggle: () => void;
  onCancel: () => void;
  micDisabled: boolean;
}

/** The chat's input row: the text field with its microphone and Send buttons. Presentational only. */
export function AgentChatComposer({
  inputRef,
  value,
  onChange,
  onKeyDown,
  rows,
  placeholder,
  readOnly,
  inputDisabled,
  voice,
  onSend,
  sendDisabled,
  onStop,
  stopDisabled,
}: {
  inputRef?: Ref<HTMLTextAreaElement>;
  value: string;
  onChange?: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  rows: number;
  placeholder: string;
  readOnly?: boolean;
  inputDisabled?: boolean;
  /** The mic. Not rendered while chat voice is switched off. */
  voice?: AgentChatComposerVoice;
  onSend: () => void;
  sendDisabled: boolean;
  onStop?: () => void;
  stopDisabled?: boolean;
}) {
  return (
    <div className="flex items-end gap-2">
      <div className="relative flex-1" {...{ [EDITOR_TOUR_ANCHOR_ATTRIBUTE]: EDITOR_TOUR_ANCHORS.chatComposer }}>
        {/* 16px text on touch (iOS zooms the page into a smaller field); about two lines on a
            short screen (a phone on its side), so the conversation keeps the height. */}
        <textarea
          ref={inputRef}
          value={value}
          onChange={onChange ? (event) => onChange(event.target.value) : undefined}
          readOnly={readOnly}
          rows={rows}
          placeholder={placeholder}
          // `block`: an inline textarea leaves a line's descender gap under it, so the buttons laid over it (inset from this
          // wrapper) hung past the box's bottom edge.
          className={`block min-h-10 w-full resize-none rounded-xl border border-border/70 bg-card px-3 py-2 ${onStop ? 'pr-20 [@media(pointer:coarse)]:pr-28' : 'pr-12 [@media(pointer:coarse)]:pr-14'} [@media(pointer:coarse)]:min-h-[3.25rem] text-sm leading-5 [@media(pointer:coarse)]:text-base [@media(max-height:500px)]:max-h-[4.75rem] outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/50`}
          disabled={inputDisabled}
          onKeyDown={onKeyDown}
        />

        {/* A finger gets a 44 px Send, resting in the corner by the thumb. */}
        <div className={`absolute inset-y-4 right-2 z-10 flex flex-col gap-2 ${onStop ? 'w-[4.5rem] [@media(pointer:coarse)]:inset-y-1 [@media(pointer:coarse)]:right-1 [@media(pointer:coarse)]:w-24' : 'w-8 [@media(pointer:coarse)]:inset-y-1 [@media(pointer:coarse)]:right-1 [@media(pointer:coarse)]:w-11'}`}>
          {CHAT_VOICE_ENABLED && voice && (
          <div className={`relative flex min-h-0 flex-1 items-center justify-center ${onStop ? 'w-8 self-end [@media(pointer:coarse)]:w-11' : ''}`}>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className={voice.isRecording
                ? 'relative h-full w-full rounded-xl bg-red-500 text-white transition-colors hover:bg-red-600'
                : 'relative h-full w-full rounded-xl bg-muted/80 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'}
              onClick={voice.onToggle}
              disabled={voice.micDisabled}
              title={voice.isRecording ? 'Stop recording' : 'Voice input (Cmd+Shift+R)'}
            >
              {voice.isRecording ? <Square className="h-3 w-3" /> : <Mic className="h-3.5 w-3.5" />}
            </Button>
            {voice.isRecording && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="absolute -right-2 -top-2 h-5 w-5 rounded-full bg-muted hover:bg-destructive hover:text-destructive-foreground"
                onClick={voice.onCancel}
                title="Cancel recording"
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
          )}

          <div className={`flex min-h-0 flex-1 items-center justify-center [@media(pointer:coarse)]:items-end ${onStop ? 'flex-row gap-2' : ''}`}>
            {onStop && (
              <Button
                type="button"
                size="icon"
                variant="secondary"
                className="h-full w-8 shrink-0 rounded-xl bg-muted/80 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive [&_svg]:size-3 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:rounded-[10px]"
                onClick={onStop}
                disabled={stopDisabled}
                title="Stop"
                aria-label="Stop"
              >
                <Square className="fill-current" />
              </Button>
            )}
            <Button
              type="button"
              size="icon"
              variant="default"
              className={`h-full ${onStop ? 'min-w-0 flex-1' : 'w-full'} rounded-xl [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:rounded-[10px]`}
              onClick={onSend}
              disabled={sendDisabled}
              title="Send"
              {...{ [EDITOR_TOUR_ANCHOR_ATTRIBUTE]: EDITOR_TOUR_ANCHORS.chatSend }}
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
