import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { createShareMetaPlugin, shareMetaTags, withShareMeta } from "../../config/vite/shareMeta";
import { PUBLIC_ASTRID_SHARE_PAGES } from "../pages/Home/publicAstridShare";

const ORIGIN = "https://astrid.test";
const indexHtml = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");
const metaContent = (html: string, key: string) =>
  html.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`))?.[1];

describe("share-card meta", () => {
  it("gives the home page an absolute 1200×630 card for Open Graph and X", () => {
    const html = createShareMetaPlugin(ORIGIN).transformIndexHtml(indexHtml);

    expect(html).toContain("<title>Astrid</title>");
    expect(metaContent(html, "og:image")).toBe(`${ORIGIN}/astrid-share.png`);
    expect(metaContent(html, "twitter:image")).toBe(`${ORIGIN}/astrid-share.png`);
    expect(metaContent(html, "twitter:card")).toBe("summary_large_image");
    expect(metaContent(html, "og:image:width")).toBe("1200");
    expect(metaContent(html, "og:url")).toBe(`${ORIGIN}/`);
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/" />`);
  });

  it("serves the Vision card for /vision in dev", () => {
    const html = createShareMetaPlugin(ORIGIN).transformIndexHtml(indexHtml, { originalUrl: "/vision?source=review", server: {} });

    expect(html).toContain("<title>Vision · Astrid</title>");
    expect(metaContent(html, "og:image")).toBe(`${ORIGIN}/astrid-share-vision.png`);
    expect(metaContent(html, "og:url")).toBe(`${ORIGIN}/vision`);
  });

  it("writes vision.html beside the built index.html", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astrid-share-"));
    fs.writeFileSync(path.join(dir, "index.html"), withShareMeta(indexHtml, "home", ORIGIN));

    createShareMetaPlugin(ORIGIN).writeBundle({ dir });

    const vision = fs.readFileSync(path.join(dir, "vision.html"), "utf8");
    expect(metaContent(vision, "og:title")).toBe("Astrid: Vision");
    expect(vision.match(/og:image"/g)).toHaveLength(1);
  });

  it("escapes copy into attributes", () => {
    expect(shareMetaTags("vision", ORIGIN)).not.toMatch(/content="[^"]*<[^"]*"/);
    expect(shareMetaTags("home", ORIGIN)).toContain("“Push local AI to its creative limits.”");
  });

  it("ships both card images", () => {
    for (const page of Object.values(PUBLIC_ASTRID_SHARE_PAGES)) {
      expect(fs.existsSync(path.resolve(__dirname, "../../public", page.image.slice(1)))).toBe(true);
    }
  });
});
