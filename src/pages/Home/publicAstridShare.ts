/**
 * How each public page reads when someone shares its link (Discord, X, Slack, iMessage, WhatsApp, LinkedIn…)
 * and in the browser tab. Crawlers never run the app, so the Vite share-meta plugin
 * (config/vite/shareMeta.ts) writes these into the HTML itself; the site sets the tab title as it moves
 * between pages. The static share description is generic; the detailed vision is fetched at runtime.
 */
export interface PublicAstridSharePage {
  path: string;
  /** Browser tab title. */
  title: string;
  /** The link card's title. The headline is in the image, so the title stays the name. */
  shareTitle: string;
  description: string;
  /** 1200×630 card from public/, rendered from the real sky (see the image alt for what it shows). */
  image: string;
  imageAlt: string;
}

export const PUBLIC_ASTRID_SHARE_PAGES = {
  home: {
    path: '/',
    title: 'Astrid',
    shareTitle: 'Astrid',
    description: 'An agent-powered video editor built to unlock the artistic potential of open-source models.',
    image: '/astrid-share.png',
    imageAlt: 'Astrid, the pixel mink, looks up into a morning sky beside the words “Push local AI to its creative limits.”',
  },
  vision: {
    path: '/vision',
    title: 'Vision · Astrid',
    shareTitle: 'Astrid: Vision',
    description: 'Explore Astrid’s vision, operating principles, progress and open creative projects.',
    image: '/astrid-share-vision.png',
    imageAlt: 'Astrid, the pixel mink, looks up at the moon beside the words “A local-first tool + agent to unlock open-source’s artistic potential.”',
  },
} as const satisfies Record<string, PublicAstridSharePage>;

export type PublicAstridSharePageName = keyof typeof PUBLIC_ASTRID_SHARE_PAGES;

/** Where the site is published; share cards need absolute links. Override with ASTRID_SITE_ORIGIN at build. */
export const PUBLIC_ASTRID_SITE_ORIGIN = 'https://astrid.haus';
