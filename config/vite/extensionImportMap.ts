import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { OutputBundle, OutputChunk } from 'rollup';
import type { Plugin, ViteDevServer } from 'vite';

export const EXTENSION_IMPORT_MAP_ID = 'astrid-extension-importmap';
export const EXTENSION_SHARED_MODULES_ID = 'astrid-extension-shared-modules';
export const EXTENSION_SHARED_MODULES_FILE = 'extension-shared-modules.json';

export type SharedModuleSpecifier =
  | 'react'
  | 'react/jsx-runtime'
  | 'react/jsx-dev-runtime'
  | 'react-dom/client'
  | 'remotion'
  | '@astrid/editor-sdk';

export interface SharedModuleBinding {
  readonly url: string;
  readonly sha256: string;
  readonly version: string;
}

export interface ExtensionSharedModuleLock {
  readonly version: 1;
  readonly shared_modules: Readonly<Record<SharedModuleSpecifier, SharedModuleBinding>>;
}

const MODULE_VERSIONS: Readonly<Record<SharedModuleSpecifier, string>> = Object.freeze({
  react: '18.3.1',
  'react/jsx-runtime': '18.3.1',
  'react/jsx-dev-runtime': '18.3.1',
  'react-dom/client': '18.3.1',
  remotion: '4.0.509',
  '@astrid/editor-sdk': '1.0.0',
});

const DEFAULT_EXPORTS = new Set<SharedModuleSpecifier>(['react']);
const COMMONJS_EXPORTS: Partial<Record<SharedModuleSpecifier, readonly string[]>> = Object.freeze({
  react: Object.freeze([
    'Children', 'Component', 'Fragment', 'Profiler', 'PureComponent', 'StrictMode', 'Suspense',
    '__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED', 'act', 'cloneElement', 'createContext',
    'createElement', 'createFactory', 'createRef', 'forwardRef', 'isValidElement', 'lazy', 'memo',
    'startTransition', 'unstable_act', 'useCallback', 'useContext', 'useDebugValue', 'useDeferredValue',
    'useEffect', 'useId', 'useImperativeHandle', 'useInsertionEffect', 'useLayoutEffect', 'useMemo',
    'useReducer', 'useRef', 'useState', 'useSyncExternalStore', 'useTransition', 'version',
  ]),
  'react/jsx-runtime': Object.freeze(['Fragment', 'jsx', 'jsxs']),
  'react/jsx-dev-runtime': Object.freeze(['Fragment', 'jsxDEV']),
  'react-dom/client': Object.freeze(['createRoot', 'hydrateRoot']),
});
const PREFIX = '\0astrid-extension-shared:';
/**
 * Dev-server URL for the same wrappers, under /assets/ like the build's, so the loader's one lock check (url shape,
 * digest, version, map-equals-lock) passes unrelaxed in dev. Each file is `astrid-extension-shared-<sanitized specifier>.js`.
 */
const DEV_DIRECTORY = '/assets/astrid-extension-shared-';

function virtualId(specifier: SharedModuleSpecifier): string {
  return `${PREFIX}${specifier}`;
}

function sanitizedName(specifier: SharedModuleSpecifier): string {
  return specifier.replace(/[^a-zA-Z0-9]+/g, '-');
}

function devUrl(specifier: SharedModuleSpecifier): string {
  return `${DEV_DIRECTORY}${sanitizedName(specifier).replace(/^-+|-+$/g, '')}.js`;
}

function devSpecifierFor(requestUrl: string): SharedModuleSpecifier | undefined {
  const pathname = requestUrl.split('?')[0];
  return (Object.keys(MODULE_VERSIONS) as SharedModuleSpecifier[]).find((specifier) => devUrl(specifier) === pathname);
}

function wrapperSource(specifier: SharedModuleSpecifier): string {
  const commonJsExports = COMMONJS_EXPORTS[specifier];
  if (commonJsExports) {
    const singleton = '__astridSharedModule';
    const defaultExport = DEFAULT_EXPORTS.has(specifier) ? `\nexport default ${singleton};` : '';
    return [
      `import ${singleton} from ${JSON.stringify(specifier)};`,
      ...commonJsExports.map((name) => `export const ${name} = ${singleton}.${name};`),
      defaultExport,
      '',
    ].join('\n');
  }
  const defaultExport = DEFAULT_EXPORTS.has(specifier)
    ? `\nexport { default } from ${JSON.stringify(specifier)};`
    : '';
  return `export * from ${JSON.stringify(specifier)};${defaultExport}\n`;
}

function sha256(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

function verifyPackageLock(root: string): void {
  let lock: { packages?: Record<string, { version?: unknown }> };
  try {
    lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as typeof lock;
  } catch {
    throw new Error('The extension shared-module lock requires the app package-lock.json.');
  }
  const expected: Partial<Record<SharedModuleSpecifier, string>> = {
    react: 'node_modules/react',
    'react/jsx-runtime': 'node_modules/react',
    'react/jsx-dev-runtime': 'node_modules/react',
    'react-dom/client': 'node_modules/react-dom',
    remotion: 'node_modules/remotion',
  };
  for (const [specifier, packagePath] of Object.entries(expected) as Array<[SharedModuleSpecifier, string]>) {
    const actual = lock.packages?.[packagePath]?.version;
    if (actual !== MODULE_VERSIONS[specifier]) {
      throw new Error(`The package lock version for ${specifier} must be ${MODULE_VERSIONS[specifier]}.`);
    }
  }
}

function findChunk(bundle: OutputBundle, fileName: string): OutputChunk | undefined {
  const output = bundle[fileName];
  return output?.type === 'chunk' ? output : undefined;
}

/** The lock and the import map the page carries, built from one set of bindings in dev and build alike. */
function sharedModuleScripts(sharedModules: Record<SharedModuleSpecifier, SharedModuleBinding>): { lock: ExtensionSharedModuleLock; html: string } {
  const lock: ExtensionSharedModuleLock = Object.freeze({ version: 1 as const, shared_modules: Object.freeze(sharedModules) });
  const imports = Object.fromEntries(Object.entries(sharedModules).map(([specifier, binding]) => [specifier, binding.url]));
  return { lock, html: [
    `<script type="application/json" id="${EXTENSION_SHARED_MODULES_ID}">${JSON.stringify(lock)}</script>`,
    `<script type="importmap" id="${EXTENSION_IMPORT_MAP_ID}">${JSON.stringify({ imports })}</script>`,
  ].join('\n') };
}

function injectIntoHead(html: string, scripts: string): string {
  const openingHead = /<head(?:\s[^>]*)?>/i;
  if (!openingHead.test(html)) throw new Error('Built index.html has no <head> element for the extension import map.');
  return html.replace(openingHead, (head) => `${head}\n${scripts}`);
}

/**
 * The same six singleton wrappers serve both modes, so one loader and one import map contract work everywhere.
 * Build emits them as entry chunks of the host Rollup graph and records their digests in the lock. Dev serves each
 * wrapper through Vite's own transform pipeline at a stable URL, so bare imports inside the wrapper resolve to the
 * same optimized dependency URLs as the host app: React/SDK identity holds in both modes.
 */
export function createExtensionImportMapPlugin(): Plugin {
  const references = new Map<SharedModuleSpecifier, string>();
  let isBuild = false;
  let devServer: ViteDevServer | undefined;

  return {
    name: 'astrid-extension-import-map',
    configResolved(resolved) {
      if (resolved.base !== '/') {
        throw new Error('The extension import map requires a root-relative Vite base.');
      }
      if ((resolved.build.assetsDir || 'assets') !== 'assets') {
        throw new Error('The extension import map requires build.assetsDir to be "assets".');
      }
      verifyPackageLock(resolved.root);
      isBuild = resolved.command === 'build';
    },
    configureServer(server) {
      devServer = server;
      // Registered before Vite's internal middlewares so a wrapper URL is never answered by the file-system fallback.
      server.middlewares.use(async (request, response, next) => {
        const specifier = devSpecifierFor(request.url ?? '');
        if (!specifier) {
          next();
          return;
        }
        try {
          const result = await server.transformRequest(virtualId(specifier));
          if (!result) throw new Error(`Shared module ${specifier} produced no dev module.`);
          response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          response.setHeader('Cache-Control', 'no-cache');
          response.end(result.code);
        } catch (error) {
          next(error);
        }
      });
    },
    async transformIndexHtml(html) {
      if (isBuild) return html;
      // The digest is of the exact wrapper bytes the dev server answers with, as in the build's lock.
      const sharedModules = {} as Record<SharedModuleSpecifier, SharedModuleBinding>;
      for (const specifier of Object.keys(MODULE_VERSIONS) as SharedModuleSpecifier[]) {
        const result = await devServer?.transformRequest(virtualId(specifier));
        if (!result) throw new Error(`Shared module ${specifier} produced no dev module.`);
        sharedModules[specifier] = Object.freeze({ url: devUrl(specifier), sha256: sha256(result.code), version: MODULE_VERSIONS[specifier] });
      }
      return injectIntoHead(html, sharedModuleScripts(sharedModules).html);
    },
    resolveId(source) {
      return source.startsWith(PREFIX) ? source : null;
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      const specifier = id.slice(PREFIX.length) as SharedModuleSpecifier;
      if (!(specifier in MODULE_VERSIONS)) return null;
      return wrapperSource(specifier);
    },
    buildStart() {
      if (!isBuild) return;
      references.clear();
      for (const specifier of Object.keys(MODULE_VERSIONS) as SharedModuleSpecifier[]) {
        references.set(specifier, this.emitFile({
          type: 'chunk',
          id: virtualId(specifier),
          name: `astrid-extension-shared-${specifier.replace(/[^a-zA-Z0-9]+/g, '-')}`,
          preserveSignature: 'strict',
        }));
      }
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const sharedModules = {} as Record<SharedModuleSpecifier, SharedModuleBinding>;
        for (const [specifier, reference] of references) {
          const fileName = this.getFileName(reference);
          if (!fileName.startsWith('assets/')) {
            this.error(`Shared module ${specifier} was emitted outside assets/: ${fileName}`);
          }
          const chunk = findChunk(bundle, fileName);
          if (!chunk || !chunk.isEntry) this.error(`Shared module wrapper missing from final bundle: ${specifier}`);
          sharedModules[specifier] = Object.freeze({
            url: `/${fileName}`,
            sha256: sha256(chunk.code),
            version: MODULE_VERSIONS[specifier],
          });
        }
        const { lock, html: scripts } = sharedModuleScripts(sharedModules);
        const lockJson = `${JSON.stringify(lock, null, 2)}\n`;
        this.emitFile({ type: 'asset', fileName: EXTENSION_SHARED_MODULES_FILE, source: lockJson });
        const html = bundle['index.html'];
        if (!html || html.type !== 'asset' || typeof html.source !== 'string') {
          this.error('The extension import map requires an emitted index.html asset.');
        }
        html.source = injectIntoHead(html.source, scripts);
      },
    },
  };
}
