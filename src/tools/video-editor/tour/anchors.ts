/** DOM anchors the editor tour spotlights. Prefixed so they never match the old `data-tour` selectors. */

export const EDITOR_TOUR_ANCHOR_ATTRIBUTE = 'data-editor-tour';
export const EDITOR_TOUR_TRACK_ATTRIBUTE = 'data-editor-tour-track';
/** The running tour's own overlay: the card's host and the dimming shield. */
export const EDITOR_TOUR_CARD_HOST_ATTRIBUTE = 'data-editor-tour-card-host';
export const EDITOR_TOUR_SHIELD_ATTRIBUTE = 'data-editor-tour-shield';
/**
 * On a pane that slides to its place by a CSS transform which is the identity at rest (the phone's chat): `in` while it is
 * there or on its way there. The spotlight then measures what is inside it where it will rest (`useSpotlightRects`).
 */
export const EDITOR_TOUR_REST_ATTRIBUTE = 'data-editor-tour-rest';

export const EDITOR_TOUR_ANCHORS = Object.freeze({
  chatComposer: 'chat-composer',
  chatSend: 'chat-send',
  chatTranscript: 'chat-transcript',
  /** The act's exchange in the tour's own chat: the sent prompt with the thinking line or the reply under it (not its actions). */
  chatExchange: 'chat-exchange',
  /** The tour's whole chat pane: the card keeps clear of it while the chat is not what is lit. */
  chatPane: 'chat-pane',
  /** The act's tool actions in the tour's chat (the "N actions" group and its cards). */
  chatActions: 'chat-actions',
  timeline: 'timeline',
  preview: 'preview',
  /** The tour's Generations pane, at its resting rect (an invisible box beside the sliding pane, not the pane). */
  generationsPane: 'generations-pane',
} as const);

export type EditorTourAnchor = (typeof EDITOR_TOUR_ANCHORS)[keyof typeof EDITOR_TOUR_ANCHORS];

/** Track ids on the demo timeline; track rows carry them in `data-editor-tour-track`. */
export const EDITOR_TOUR_TRACK_IDS = Object.freeze({
  scene: 'tour-scene',
  stills: 'tour-stills',
  videos: 'tour-videos',
} as const);

export function editorTourSelector(anchor: EditorTourAnchor): string {
  return `[${EDITOR_TOUR_ANCHOR_ATTRIBUTE}="${anchor}"]`;
}

export function editorTourTrackSelector(trackId: string): string {
  return `[${EDITOR_TOUR_TRACK_ATTRIBUTE}="${trackId}"]`;
}
