/**
 * Remove only the declarative Google Fonts links from the HTML document.
 *
 * This is deliberately a Vite HTML transform rather than browser-side code:
 * the offline browser-test mode must be able to prove that no remote-font
 * request can be initiated by the document at all. Production HTML remains
 * byte-for-byte untouched unless the explicit test flag is enabled.
 */
export const stripRemoteFontLinks = (html: string): string => html.replace(
  /[ \t]*<link\b(?=[^>]*\bhref\s*=\s*["']https:\/\/fonts(?:\.googleapis|\.gstatic)\.com[^>]*>)[^>]*>\s*/gi,
  "",
);

export const createRemoteFontModePlugin = (disableRemoteFonts: boolean) => ({
  name: "astrid-remote-font-mode",
  transformIndexHtml(html: string) {
    return disableRemoteFonts ? stripRemoteFontLinks(html) : html;
  },
});
