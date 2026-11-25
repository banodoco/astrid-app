import fs from "fs";
import { defineConfig, createLogger, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import {
  manualVendorChunk,
  PREVIEW_ALLOWED_HOSTS,
  resolveVitePort,
} from "./policy";
import {
  createAstridAcpBridgeProxyOptions,
  createAstridBridgeAuthPlugin,
  createAstridBridgeProxyOptions,
  resolveAstridAcpBridgePort,
  resolveAstridBridgePort,
  resolveAstridBridgeProxyPolicy,
} from "./astridBridgeProxy";
import { createRuntimeOperationAdmissionPlugin, createRuntimeOperationProxyOptions, createWorkspaceRuntimeProxyOptions, RUNTIME_TOKEN_FILE_ENV } from "./runtimeProxy";
import { resolveAstridSource, validateAstridToolCatalog } from "./astridSource";
import {
  createAstridGenerationComposer,
  resolveAstridGenerationComposer,
} from "./astridGenerationCompose";
import { createBundleBudgetPlugin } from "./bundleBudget";
import { createPairedRelayPlugin, resolvePairedRelayConfig } from "./pairedRelay";
import { createShareMetaPlugin } from "./shareMeta";
import { createInstallerAssetsPlugin } from "./installerAssets";
import { createPreviewCacheHeadersPlugin } from "./previewCacheHeaders";
import { createAppBuildPlugin } from "./appBuild";
import { createLocalUpdateStatusPlugin } from "./localUpdateStatus";
import { createLocalUpdatePagePlugin } from "./localUpdatePage";
import { createExtensionImportMapPlugin } from "./extensionImportMap";
import { LOCAL_WORKSPACE_ORIGIN_HEADER } from "../../src/integrations/runtime/workspaceRuntimeConfig";

const logger = createLogger();
const originalWarn = logger.warn.bind(logger);
logger.warn = (msg, options) => {
  if (msg.includes('postcss.parse') && msg.includes('from')) return;
  originalWarn(msg, options);
};

function readRuntimeProxyToken(tokenFile: string | null): string | null {
  if (!tokenFile || !fs.existsSync(tokenFile)) return null;
  const raw = fs.readFileSync(tokenFile, 'utf8').trim();
  if (!raw.startsWith('{')) return raw || null;
  try {
    const credential = JSON.parse(raw) as { token?: unknown };
    return typeof credential.token === 'string' && credential.token.trim()
      ? credential.token.trim()
      : null;
  } catch (error) {
    throw new Error(`WORKSPACE_RUNTIME_TOKEN_FILE is not valid token text or credential JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export default defineConfig(() => {
  const port = resolveVitePort(process.env.PORT);
  const astridBridgePort = resolveAstridBridgePort(process.env.VITE_ASTRID_BRIDGE_PORT);
  const astridAcpBridgePort = resolveAstridAcpBridgePort(process.env.VITE_ASTRID_ACP_BRIDGE_PORT);
  const astridBridgeProxyPolicy = resolveAstridBridgeProxyPolicy(process.env);
  const pairedRelay = createPairedRelayPlugin(resolvePairedRelayConfig(process.env));
  const localWorkspaceOrigin = `http://127.0.0.1:${port}`;
  const localWorkspaceProxy = !pairedRelay && process.env.ASTRID_RUNTIME_OPERATION_ORIGIN === localWorkspaceOrigin;
  const astridSource = resolveAstridSource();
  if (!astridSource) {
    throw new Error('The Video Editor Tool build requires ASTRID_CHECKOUT or a bundled Astrid browser source.');
  }
  validateAstridToolCatalog(astridSource.sourceRoot);
  const astridPublicSource = resolveAstridSource(
    process.env.ASTRID_PUBLIC_CHECKOUT ?? '',
    'ASTRID_PUBLIC_CHECKOUT',
  );
  const generationComposerConfig = resolveAstridGenerationComposer(process.env, astridSource?.sourceRoot);
  const generationComposer = generationComposerConfig
    ? createAstridGenerationComposer(generationComposerConfig)
    : null;
  const astridBridgeAuthPlugin = createAstridBridgeAuthPlugin(astridBridgeProxyPolicy, generationComposer);
  const astridBridgeProxy = {
    "/api/astrid": createAstridBridgeProxyOptions(
      astridBridgeProxyPolicy,
      astridBridgePort,
    ),
  };
  const astridAcpBridgeProxy = {
    "/api/astrid/acp": createAstridAcpBridgeProxyOptions(
      astridBridgeProxyPolicy,
      astridAcpBridgePort,
      process.env.ASTRID_ACP_VIA_DISCOVERY_PROXY === '1',
    ),
  };
  const runtimeTarget = process.env.VITE_WORKSPACE_RUNTIME_URL?.trim() || null;
  const runtimeTokenFile = process.env[RUNTIME_TOKEN_FILE_ENV]?.trim() || null;
  const runtimeToken = readRuntimeProxyToken(runtimeTokenFile);
  const runtimeProxy: Record<string, string | ProxyOptions> = runtimeTarget
    ? {
      "/runtime-config/v1/operation": createRuntimeOperationProxyOptions(runtimeTarget),
      "/api/runtime": createWorkspaceRuntimeProxyOptions(runtimeTarget, runtimeToken),
      "/runtime-config/v1/workspace.json": {
        target: runtimeTarget,
        changeOrigin: true,
        configure(proxy) {
          // The same compiled bundle can be served by the relay. Only the local launcher enables this read.
          proxy.on('proxyRes', (response) => {
            delete response.headers[LOCAL_WORKSPACE_ORIGIN_HEADER];
            if (localWorkspaceProxy) response.headers[LOCAL_WORKSPACE_ORIGIN_HEADER] = localWorkspaceOrigin;
          });
        },
      },
    }
    : {};
  const timelineSchemaPath = path.resolve(
    __dirname,
    "../../vendor/timeline-schema/typescript/dist/src/index.js",
  );
  const timelineSchemaFallbackPath = path.resolve(
    __dirname,
    "../../src/tools/video-editor/lib/timeline-schema.fallback.ts",
  );

  return {
    customLogger: logger,
    server: {
      host: "::",
      port: port,
      proxy: { ...astridAcpBridgeProxy, ...astridBridgeProxy, ...runtimeProxy },
      // Sprint 5: allow Vite to read from the sibling banodoco-workspace
      // (timeline-theme-2rp file: link).
      fs: {
        allow: [
          path.resolve(__dirname, "../../../.."),
          ...(astridSource ? [astridSource.checkout] : []),
          ...(astridPublicSource ? [astridPublicSource.checkout] : []),
        ],
      },
    },
    preview: {
      host: "0.0.0.0",
      port: port,
      allowedHosts: [...PREVIEW_ALLOWED_HOSTS],
      proxy: { ...astridAcpBridgeProxy, ...astridBridgeProxy, ...runtimeProxy },
    },
    plugins: [
      createRuntimeOperationAdmissionPlugin(process.env.ASTRID_RUNTIME_OPERATION_ORIGIN),
      pairedRelay,
      astridBridgeAuthPlugin,
      createShareMetaPlugin(process.env.ASTRID_SITE_ORIGIN?.trim() || undefined),
      createInstallerAssetsPlugin(),
      createAppBuildPlugin({ manifestPath: path.resolve(__dirname, "../../public/install-manifest.json"), selectedCheckout: astridSource.checkout, vendorRoot: path.resolve(__dirname, "../../vendor/astrid-browser") }),
      createLocalUpdateStatusPlugin({ manifestPath: path.resolve(__dirname, "../../public/install-manifest.json") }),
      createLocalUpdatePagePlugin(),
      createExtensionImportMapPlugin(),
      createPreviewCacheHeadersPlugin(),
      react(),
      createBundleBudgetPlugin(),
    ].filter(Boolean),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "../../src"),
        "@astrid/editor-sdk": path.resolve(__dirname, "../../src/sdk/index.ts"),
        ...(astridSource ? { "@astrid": astridSource.sourceRoot, "@astrid-rendering/shared": path.join(astridSource.sourceRoot, "packs/rendering/shared") } : {}),
        ...(astridPublicSource ? { "@astrid-public": astridPublicSource.sourceRoot } : {}),
        // Sprint 5: deduplicate React / Remotion / @banodoco/* across the
        // linked timeline-composition + timeline-theme-* packages so a
        // single React runtime drives the @remotion/player preview.
        "react": path.resolve(__dirname, "../../node_modules/react"),
        "react-dom": path.resolve(__dirname, "../../node_modules/react-dom"),
        "remotion": path.resolve(__dirname, "../../node_modules/remotion"),
        "@remotion/layout-utils": path.resolve(__dirname, "../../node_modules/@remotion/layout-utils"),
        "@remotion/media": path.resolve(__dirname, "../../node_modules/@remotion/media"),
        "@banodoco/timeline-schema": fs.existsSync(timelineSchemaPath)
          ? timelineSchemaPath
          : timelineSchemaFallbackPath,
        // Workspace-primitive aliases (mirrors banodoco shell webpack-alias.mjs).
        // Vendored into astrid-app/vendor/ so the Docker build context can resolve them
        // — the original ../../../../banodoco-workspace paths sit outside the build context.
        "@workspace-effects": path.resolve(__dirname, "../../vendor/banodoco-effects"),
        "@workspace-animations": path.resolve(__dirname, "../../vendor/banodoco-animations"),
        "@workspace-transitions": path.resolve(__dirname, "../../vendor/banodoco-transitions"),
      },
      dedupe: ['react', 'react-dom', 'react-reconciler', 'remotion', '@banodoco/timeline-composition', '@banodoco/timeline-theme-2rp'],
    },
    build: {
      outDir: "dist",
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks: manualVendorChunk,
        }
      }
    },
    optimizeDeps: {
      // The default scan walks every .html under the repo (test fixtures, examples),
      // and one vendored pack path there aborts the whole scan.
      // A failed scan leaves dependencies to be discovered lazily while the page
      // loads, and each late discovery (react-joyride) forces a full page reload.
      entries: ["index.html"],
      exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
    },
  };
});
