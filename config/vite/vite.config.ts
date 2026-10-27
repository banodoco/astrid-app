import fs from "fs";
import {execFile} from "node:child_process";
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
import { createWorkspaceRuntimeProxyOptions, RUNTIME_TOKEN_FILE_ENV } from "./runtimeProxy";
import {AstridRuntimeClient} from '../../src/integrations/runtime/client';
import { createElementAdmissionsPlugin } from "./astridElementAdmissions";
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
      "/api/runtime": createWorkspaceRuntimeProxyOptions(runtimeTarget, runtimeToken),
      "/runtime-config/v1/workspace.json": { target: runtimeTarget, changeOrigin: true },
    }
    : {};
  const elementRuntime = runtimeTarget && runtimeToken ? new AstridRuntimeClient({baseUrl:runtimeTarget,token:runtimeToken,
    expectedIdentity:{actorId:process.env.VITE_WORKSPACE_RUNTIME_EXPECTED_ACTOR_ID??'',realmId:process.env.VITE_WORKSPACE_RUNTIME_EXPECTED_REALM_ID??'',runtimeInstanceId:process.env.VITE_WORKSPACE_RUNTIME_EXPECTED_INSTANCE_ID??''}}):null;
  const elementAdmissions = elementRuntime && process.env.ASTRID_ELEMENT_ARTIFACT_ROOT && process.env.ASTRID_PROJECT_PACKS_ROOT ? {
    realmId:process.env.VITE_WORKSPACE_RUNTIME_EXPECTED_REALM_ID??'',artifactRoot:process.env.ASTRID_ELEMENT_ARTIFACT_ROOT,sourceRoot:process.env.ASTRID_PROJECT_PACKS_ROOT,
    resolveRecord:async(projectId:string,ref:{packId:string;kind:string;id:string;revision:string}):Promise<Record<string,unknown>>=>{
      const command=JSON.parse(process.env.ASTRID_ELEMENT_RESOLVE_COMMAND??'null') as string[]|null;
      if(!Array.isArray(command)||!command.length||command.some(arg=>typeof arg!=='string'||!arg))throw new Error('ASTRID_ELEMENT_RESOLVE_COMMAND must configure the canonical native resolver argv');
      return new Promise((resolve,reject)=>execFile(command[0],[...command.slice(1),'--realm',process.env.VITE_WORKSPACE_RUNTIME_EXPECTED_REALM_ID??'','--project',projectId,'--pack',ref.packId,'--element',ref.id,'--kind',ref.kind,'--revision',ref.revision],{timeout:60000,maxBuffer:2000000,env:process.env},(error,stdout,stderr)=>{
        if(error){reject(new Error('Canonical element resolver failed: '+stderr.slice(-2048)));return;}
        try{resolve(JSON.parse(stdout));}catch(parseError){reject(parseError);}
      }));
    },
    readDocument:async(projectId:string,id:string)=>{try{return await elementRuntime.getDocument(projectId,id);}catch(error){if((error as {status?:number}).status===404)return null;throw error;}},
  }:undefined;
  const generatedRegistryPath = path.resolve(
    __dirname,
    "../../node_modules/@banodoco/timeline-composition/typescript/src/registry.generated.ts",
  );
  const generatedRegistryFallbackPath = path.resolve(
    __dirname,
    "../../src/tools/video-editor/lib/registry.generated.fallback.ts",
  );
  const themeApiPath = path.resolve(
    __dirname,
    "../../node_modules/@banodoco/timeline-composition/typescript/src/theme-api.ts",
  );
  const themeApiFallbackPath = path.resolve(
    __dirname,
    "../../src/tools/video-editor/lib/theme-api.fallback.tsx",
  );
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
      createElementAdmissionsPlugin(elementAdmissions),
      pairedRelay,
      astridBridgeAuthPlugin,
      createShareMetaPlugin(process.env.ASTRID_SITE_ORIGIN?.trim() || undefined),
      createInstallerAssetsPlugin(),
      createAppBuildPlugin({ manifestPath: path.resolve(__dirname, "../../public/install-manifest.json") }),
      createLocalUpdateStatusPlugin({ manifestPath: path.resolve(__dirname, "../../public/install-manifest.json") }),
      createPreviewCacheHeadersPlugin(),
      react(),
      createBundleBudgetPlugin(),
    ].filter(Boolean),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "../../src"),
        "@astrid/editor-sdk": path.resolve(__dirname, "../../src/sdk/index.ts"),
        ...(astridSource ? { "@astrid": astridSource.sourceRoot } : {}),
        ...(astridPublicSource ? { "@astrid-public": astridPublicSource.sourceRoot } : {}),
        // Sprint 5: deduplicate React / Remotion / @banodoco/* across the
        // linked timeline-composition + timeline-theme-* packages so a
        // single React runtime drives the @remotion/player preview.
        "react": path.resolve(__dirname, "../../node_modules/react"),
        "react-dom": path.resolve(__dirname, "../../node_modules/react-dom"),
        "remotion": path.resolve(__dirname, "../../node_modules/remotion"),
        "@remotion/layout-utils": path.resolve(__dirname, "../../node_modules/@remotion/layout-utils"),
        "@remotion/media": path.resolve(__dirname, "../../node_modules/@remotion/media"),
        "@banodoco/timeline-composition/registry.generated": fs.existsSync(generatedRegistryPath)
          ? generatedRegistryPath
          : generatedRegistryFallbackPath,
        "@banodoco/timeline-composition/theme-api": fs.existsSync(themeApiPath)
          ? themeApiPath
          : themeApiFallbackPath,
        "@banodoco/timeline-schema": fs.existsSync(timelineSchemaPath)
          ? timelineSchemaPath
          : timelineSchemaFallbackPath,
        "@banodoco/timeline-composition": path.resolve(__dirname, "../../node_modules/@banodoco/timeline-composition"),
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
      // loads, and each late discovery forces a full page reload.
      entries: ["index.html"],
      exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
    },
  };
});
