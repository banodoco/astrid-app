import type { EditorTourAct } from '@/shared/state/editorTourStore';

export interface EditorTourToolCard {
  readonly name: string;
  readonly detail: string;
}

export type EditorTourVisual = 'extension' | 'frame-to-still' | 'still-to-video';

export interface EditorTourActScript {
  /** Typed into the chat composer; the user sends it. */
  readonly prompt: string;
  /** A header on the act's compose card, above "Press Send": what your agent can do in this act. */
  readonly composeHeader?: string;
  /** Streamed as Astrid's reply. */
  readonly reply: string;
  readonly toolCards: readonly EditorTourToolCard[];
  /** The explainer on the act's `land` beat; the card's counter numbers it. */
  readonly card: {
    readonly title: string;
    readonly body: string;
    readonly visual: EditorTourVisual;
    /** The visual's two small labels: what it starts from, and what made the result. */
    readonly labels: readonly [string, string];
  };
}

export interface EditorTourScript {
  readonly acts: Readonly<Record<EditorTourAct, EditorTourActScript>>;
  /** The centred card before act 1: Astrid says hello. */
  readonly welcome: { readonly title: string; readonly body: string; readonly action: string };
  /** The card's quiet line while the chat has the spotlight: before Send, and (act 1 only) while the reply plays. */
  /** Said to screen readers while a result plays alone, before its explainer appears (nothing is shown). */
  readonly watching: string;
  readonly hints: { readonly compose: string; readonly composeTouch: string; readonly respond: string; readonly respondWorking: string };
  /** `send` is a touch card's own Send, the same press as the chat's. */
  readonly controls: { readonly next: string; readonly send: string; readonly back: string; readonly skip: string };
  /** Act 2's second card, `gallery`: the Generations pane slides up. */
  readonly gallery: { readonly title: string; readonly body: string };
  /** Agent → open models → output: the card's strip, one step per act. */
  readonly strip: readonly [string, string, string];
  /** After act 3: the lit chain is the one example; the body opens it out. */
  readonly finale: { readonly title: string; readonly body: string; readonly action: string; readonly recap: readonly [string, string, string] };
  /** The last card, after the finale: Astrid asks for feedback and points to the Discord. */
  /** `mobileAction` ends the tour on a phone or tablet, where the next screen sends Astrid to a computer. */
  /** The title reads `before emphasis after`, joined by spaces; the card underlines `emphasis` once it has arrived. */
  readonly feedback: { readonly title: { readonly before: string; readonly emphasis: string; readonly after: string }; readonly body: string; readonly shortBody: string; readonly discord: string; readonly action: string; readonly mobileAction: string };
}

/**
 * The tour replays the completed Lantern Valley project; Send advances the demonstration. Each act's card title says what the agent just did (it creates and uses
 * extensions, generates with local models, brings it all together); the body carries the bigger picture.
 * Captions keep the tour's three claims and read in about two seconds.
 */
export const EDITOR_TOUR_SCRIPT = Object.freeze<EditorTourScript>({
  acts: {
    1: {
      composeHeader: 'Ask your agent to do any kind of creative work',
      prompt: 'Make me a 14-second bird flight through Lantern Valley, soaring past the mountains and descending into town.',
      reply: 'Lantern Valley is on your timeline: a 14-second live Three.js flight that climbs toward the moon, then swoops across the lake into town.',
      toolCards: [
        { name: 'Built Lantern Valley', detail: 'Three.js live scene' },
        { name: 'Placed it on the timeline', detail: 'Valley flight · 14 s' },
      ],
      card: {
        title: 'Create together with your agent using extendable tools',
        body: 'Your agent can find extensions from the ecosystem, or build its own, to help drive your creative process, all on your timeline.',
        visual: 'extension',
        labels: ['Three.js', 'extension'],
      },
    },
    2: {
      composeHeader: 'Your agent can do anything open models can do',
      prompt: 'Can you make me realistic frames for that using Qwen Image 2.1?',
      reply: 'I made four realistic reference frames with Qwen Image 2.1. They follow the flight from the valley to natural-looking buildings in town.',
      toolCards: [
        { name: 'Captured 4 frames', detail: 'Start · mountains · descent · town' },
        { name: 'Qwen Image 2.1 × 4', detail: 'Frame → realistic still' },
      ],
      card: {
        title: 'Your agent works with open models and the ecosystem’s knowledge',
        body: 'Use open models locally to generate right onto your timeline.',
        visual: 'frame-to-still',
        labels: ['Frame', 'Qwen Image 2.1'],
      },
    },
    3: {
      composeHeader: 'Your agent can combine different assets to create final generations',
      prompt: 'Now use MiniMax H3 to make a 14-second video using all four frames and the Three.js motion guide.',
      reply: 'MiniMax H3 used all four reference frames and the 14-second guide to make this flight. The finished shot is trimmed to 14 seconds on the top row, ready to play.',
      toolCards: [{ name: 'MiniMax H3', detail: '4 frames + motion guide · 14 s' }],
      card: {
        title: 'Your agent uses everything on your timeline to create the final shot',
        body: 'Every input you and your agent create gives you production‑level creative control.',
        visual: 'still-to-video',
        labels: ['MiniMax H3', '14 s'],
      },
    },
  },
  welcome: { title: 'Welcome to Astrid', body: 'Explore a completed project in this quick guided demo. The prompts replay its steps; no new generation runs.', action: 'OK' },
  watching: 'The result is playing. Its explanation follows; press Enter to skip ahead.',
  hints: { compose: 'Press Send to ask Astrid', composeTouch: 'Tap Send to ask Astrid', respond: 'Your agent uses community-built creative tools to deliver on this request', respondWorking: 'Astrid is working on it…' },
  controls: { next: 'Next', send: 'Send', back: 'Back', skip: 'Skip tour' },
  gallery: {
    title: 'And all your assets are organized automatically',
    body: 'Everything you and your agent generate is kept here to view and edit. Use any model, create variants, and let your agent organize them with custom data.',
  },
  strip: ['Agent', 'Open models', 'Output'],
  finale: {
    title: 'And this is just one example',
    body: 'There are infinite possibilities when you combine open models with custom agent tools and human interfaces.',
    action: 'Next',
    recap: ['Agent + extensions', 'Open models', 'Finished shot'],
  },
  feedback: {
    title: { before: 'We', emphasis: 'really', after: 'need your feedback' },
    body: 'We’re aiming for a tool that helps unlock the creative potential of open models and the open‑source community. But Astrid is a very early-stage product, and in many ways it doesn’t get there yet. Feedback on any issue you hit helps us improve it: no problem is too large or too small.',
    /** A phone's version: the same ask in a few lines. */
    shortBody: 'Astrid is very early, and in many ways it doesn’t get there yet. Tell us about any issue you hit: no problem is too large or too small.',
    discord: 'Join the Discord',
    action: 'Start creating',
    mobileAction: 'Finish the tour',
  },
});
