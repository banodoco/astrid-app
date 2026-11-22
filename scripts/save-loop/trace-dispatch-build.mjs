/** Build the diagnostic bundle through the stock local workspace build launcher. */
import {execFileSync, spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {compiledAnchorCount, compiledModulePaths, instrumentCompiledModule} from './trace-dispatch-modules.mjs';

export const productRevision = 'e3dbad64d402724ac5a35fb6447f18e432c64b78';
const configFile = 'config/vite/vite.config.ts';
const fixedPaths = compiledModulePaths;
const toolPaths = ['trace-dispatch-build.mjs', 'trace-dispatch-modules.mjs', 'trace-dispatch.mjs'];
const usage = 'Usage: node scripts/save-loop/trace-dispatch-build.mjs --out-dir NEW_ABSOLUTE_DIR --receipt NEW_ABSOLUTE_JSON';
const digest = value => createHash('sha256').update(value).digest('hex');
const fingerprint = value => digest(JSON.stringify(value));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const git = (product, ...args) => execFileSync('git', ['-C', product, ...args], {stdio: ['ignore', 'pipe', 'ignore']});
const productBlob = (product, file) => git(product, 'show', `${productRevision}:${file}`);
const toolSources = () => Object.fromEntries(toolPaths.map(file => [file, digest(fs.readFileSync(new URL(file, import.meta.url)))]));

export function verifyCompiledLock(root) {
  // The restore operator already opens and holds the canonical one-root flock
  // on fd 9. Check the inherited inode and retain its exclusive lock for this run.
  const file = process.env.SAVE_LOOP_COMPILED_LOCK;
  if (!file || file !== fs.realpathSync(file) || path.basename(file) !== 'one-root.lock' ||
      path.basename(path.dirname(file)) !== '.locks' || !root.startsWith(`${path.dirname(path.dirname(file))}${path.sep}`)) {
    throw new Error('Compiled trace requires the owned restore lock path');
  }
  const inherited = fs.fstatSync(9, {bigint: true});
  const expected = fs.statSync(file, {bigint: true});
  if (!expected.isFile() || expected.dev !== inherited.dev || expected.ino !== inherited.ino) {
    throw new Error('Compiled trace requires the inherited restore lock on fd 9');
  }
  execFileSync('flock', ['-xn', '3'], {stdio: ['ignore', 'ignore', 'ignore', 9]});
}

function requireProduct(product) {
  if (git(product, 'rev-parse', 'HEAD').toString().trim() !== productRevision ||
      git(product, 'status', '--porcelain', '--untracked-files=normal').length) {
    throw new Error('Product App must be clean at the pinned current Release 15 revision');
  }
}

function productInputs(product) {
  requireProduct(product);
  const pkg = JSON.parse(productBlob(product, 'package.json'));
  if (pkg.scripts?.build !== `vite build --config ${configFile}` || pkg.scripts.prebuild || pkg.scripts.postbuild) {
    throw new Error('Unexpected product build script');
  }
  const lock = productBlob(product, 'package-lock.json');
  return {
    app: productRevision,
    tree: git(product, 'rev-parse', 'HEAD^{tree}').toString().trim(),
    bundled_browser_tree: git(product, 'rev-parse', 'HEAD:vendor/astrid-browser').toString().trim(),
    package_lock_sha256: digest(lock),
    config_sha256: digest(productBlob(product, configFile)),
    vite: JSON.parse(lock).packages['node_modules/vite'].version,
    tooling_sha256: toolSources(),
  };
}

async function fileSha(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function inventory(root) {
  if (root !== fs.realpathSync(root) || !fs.statSync(root).isDirectory()) throw new Error('Invalid compiled artifact directory');
  const files = [];
  async function walk(directory, prefix = '') {
    const entries = await fs.promises.readdir(directory, {withFileTypes: true});
    for (const entry of entries) {
      if (/^\.env(?:\.|$)|(?:^|[._-])(?:credentials?|tokens?|secrets?)(?:[._-]|$)/i.test(entry.name) ||
          (!entry.isFile() && !entry.isDirectory())) throw new Error('Unexpected compiled artifact entry');
      const file = path.join(directory, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(file, `${name}/`);
      else files.push({file: name, sha256: await fileSha(file)});
    }
  }
  await walk(root);
  return files.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
}

function validModules(modules, inputs, product) {
  return Array.isArray(modules) && modules.length === fixedPaths.length &&
    fixedPaths.every((modulePath, index) => {
      const row = modules[index];
      return row?.path === modulePath && row.module === path.basename(modulePath) &&
        row.anchors === compiledAnchorCount(modulePath) &&
        row.source_sha256 === digest(productBlob(product, modulePath.slice(1))) && sha(row.original_js_sha256) &&
        sha(row.observed_js_sha256) && row.marker === `p77:${inputs.build_id}:${digest(`${modulePath}:${row.source_sha256}:${row.original_js_sha256}`)}` &&
        /^assets\/[^/]+\.js$/.test(row.chunk);
    });
}

async function artifactFiles(root, modules) {
  const files = await inventory(root);
  const names = new Set(files.map(row => row.file));
  if (!names.has('index.html') || !names.has('build.json') ||
      !modules.every(row => names.has(row.chunk)) || !files.some(row => /^assets\/index-[^/]+\.js$/.test(row.file))) {
    throw new Error('Incomplete compiled artifact');
  }
  const producer = JSON.parse(fs.readFileSync(path.join(root, 'build.json'), 'utf8'));
  if (producer.app !== productRevision) throw new Error('Unexpected packaged App producer');
  const audited = new Map();
  for (const {chunk, marker} of modules) {
    if (!audited.has(chunk)) audited.set(chunk, fs.readFileSync(path.join(root, chunk), 'utf8'));
    if (!audited.get(chunk).includes(marker)) throw new Error('Instrumentation marker missing from packaged chunk');
  }
  return files;
}

export async function verifyCompiledArtifact(receiptFile, receiptSha, product) {
  const raw = fs.readFileSync(receiptFile);
  if (!sha(receiptSha) || digest(raw) !== receiptSha) throw new Error('Compiled receipt SHA does not match');
  const receipt = JSON.parse(raw);
  const {inputs, modules, files, output_dir: directory} = receipt;
  const source = productInputs(product);
  if (receipt.format !== 1 || !isDeepStrictEqual(source, inputs?.source) || receipt.inputs_sha256 !== fingerprint(inputs) ||
      !validModules(modules, inputs, product) || !isDeepStrictEqual(inputs.transforms, modules) ||
      directory !== path.resolve(directory) || directory.startsWith(`${product}${path.sep}`)) {
    throw new Error('Compiled receipt does not match the pinned source and transforms');
  }
  const observed = await artifactFiles(directory, modules);
  if (!isDeepStrictEqual(files, observed) || receipt.output_sha256 !== fingerprint(observed)) {
    throw new Error('Compiled output files do not match the build receipt');
  }
  return {receipt};
}

export async function verifyCompiledPreview(pid, command, product, artifact) {
  const index = command.indexOf('--preview-dir');
  if (!command.includes('--preview') || command.includes('--build') ||
      index < 0 || command[index + 1] !== artifact.receipt.output_dir ||
      fs.realpathSync(`/proc/${pid}/cwd`) !== product ||
      await fileSha(`/proc/${pid}/exe`) !== artifact.receipt.inputs.node.sha256) {
    throw new Error('Owned launcher is not previewing the frozen build with the recorded Node');
  }
}

export async function buildFromLauncher(args, settings) {
  const {product, output, stage, buildId, node} = settings;
  if (!isDeepStrictEqual(args, ['run', 'build']) || process.cwd() !== product || process.execPath !== node.exec_path ||
      process.version !== node.version || fs.readdirSync(output).length ||
      (process.env.NODE_ENV && process.env.NODE_ENV !== 'production')) throw new Error('Unexpected compiled build invocation');

  const source = productInputs(product);
  const require = createRequire(path.join(product, 'package.json'));
  const {build, version} = await import(pathToFileURL(path.join(product, 'node_modules/vite/dist/node/index.js')).href);
  const MagicString = require('magic-string');
  if (version !== source.vite) throw new Error('Unexpected installed Vite version');
  const pinned = new Map(fixedPaths.map(file => [`${product}${file}`, productBlob(product, file.slice(1)).toString()]));
  const verified = new Set();
  const transforms = new Map();
  const packaged = new Map();
  let production;
  const plugins = [
    {
      name: 'p77-pinned-dispatch-source',
      apply: 'build',
      enforce: 'pre',
      transform(code, id) {
        if (!pinned.has(id)) return null;
        if (verified.has(id) || code !== pinned.get(id)) throw new Error('Compiled module source does not match its pinned TypeScript blob');
        verified.add(id);
        return null;
      },
    },
    {
      name: 'p77-compiled-dispatch',
      apply: 'build',
      enforce: 'post',
      configResolved(config) {
        const browserSource = path.join(product, 'vendor/astrid-browser/astrid');
        const aliases = new Map(config.resolve.alias.map(({find, replacement}) => [find, replacement]));
        if (config.root !== product || config.configFile !== path.join(product, configFile) ||
            config.mode !== 'production' || !config.isProduction || config.base !== '/' || config.build.minify !== 'esbuild' ||
            aliases.get('@astrid') !== browserSource || aliases.get('@astrid-public') !== browserSource ||
            config.build.sourcemap !== true || config.build.ssr || !config.plugins.some(plugin => plugin.name === 'astrid-production-bundle-budget')) {
          throw new Error('Unexpected production Vite configuration');
        }
        production = {mode: config.mode, base: config.base, minify: config.build.minify, sourcemap: config.build.sourcemap, target: config.build.target};
      },
      transform(original, id) {
        if (!pinned.has(id)) return null;
        if (!verified.has(id) || transforms.has(id)) throw new Error('Unexpected repeated or unverified transform');
        const {code, map, audit} = instrumentCompiledModule(id.slice(product.length), original, pinned.get(id), buildId, MagicString);
        transforms.set(id, audit);
        return {code, map};
      },
      generateBundle(_options, outputs) {
        for (const [id, audit] of transforms) {
          const chunks = Object.values(outputs).filter(item => item.type === 'chunk' && item.moduleIds.includes(id) && item.code.includes(audit.marker));
          if (chunks.length !== 1 || packaged.has(id)) throw new Error('Compiled module does not have one emitted marker chunk');
          packaged.set(id, {...audit, chunk: chunks[0].fileName});
        }
      },
    },
  ];
  await build({configFile: path.join(product, configFile), plugins, build: {outDir: output, emptyOutDir: false}});
  const modules = fixedPaths.map(file => packaged.get(`${product}${file}`));
  const inputs = {source, node, production, build_id: buildId, transforms: modules};
  if (!validModules(modules, inputs, product)) throw new Error('Incomplete compiled module audit');
  fs.writeFileSync(stage, JSON.stringify({inputs, modules}), {flag: 'wx', mode: 0o600});
}

function newPath(value) {
  if (!value || value !== path.resolve(value) || path.dirname(value) !== fs.realpathSync(path.dirname(value)) || fs.existsSync(value)) {
    throw new Error('Compiled build needs new absolute artifact and receipt paths');
  }
  return value;
}

async function run(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--out-dir', '--receipt'].includes(argv[i]) || args.has(argv[i]) || !argv[i + 1]) throw new Error(usage);
    args.set(argv[i], argv[i + 1]);
  }
  if (args.size !== 2) throw new Error(usage);
  const output = newPath(args.get('--out-dir'));
  const receiptFile = newPath(args.get('--receipt'));
  const {SAVE_LOOP_ROOT: root, SAVE_LOOP_RUNTIME_DATA_ROOT: data, SAVE_LOOP_PRODUCT_APP: product} = process.env;
  if (![root, data, product].every(dir => dir && dir === fs.realpathSync(dir) && fs.statSync(dir).isDirectory()) ||
      !data.startsWith(`${root}${path.sep}`) ||
      fs.readFileSync(path.join(root, '.sl1-stack-owned'), 'utf8') !== `astrid-app-sl1-stack-v1 ${root}` ||
      output === receiptFile || [output, receiptFile].some(file => [root, product].some(dir => file.startsWith(`${dir}${path.sep}`))) ||
      !receiptFile.endsWith('.json')) throw new Error('Compiled build needs an owned stack and external artifact and receipt paths');
  verifyCompiledLock(root);
  requireProduct(product);
  const node = {version: process.version, exec_path: process.execPath, sha256: await fileSha(process.execPath)};
  fs.mkdirSync(output, {mode: 0o700});
  const staging = fs.mkdtempSync(path.join(path.dirname(output), '.p77-build-'));
  try {
    const stage = path.join(staging, 'module-audit.json');
    const trampoline = path.join(staging, 'npm-cli.js');
    const settings = {product, output, stage, node, buildId: randomUUID()};
    // Written outside the App and exposed only to this launcher's build child.
    fs.writeFileSync(trampoline, `import(${JSON.stringify(import.meta.url)})
  .then(driver => driver.buildFromLauncher(process.argv.slice(2), ${JSON.stringify(settings)}))
  .catch(error => {
    const message = error?.message ?? '';
    console.error(/^\\/src\\/tools\\/video-editor\\/[A-Za-z0-9/.]+: compiled anchor \\d+ matched \\d+ times$/.test(message) ? message : 'Compiled Vite build or instrumentation failed');
    process.exitCode = 1;
  });\n`, {flag: 'wx', mode: 0o600});
    const launcher = spawn(process.execPath, ['scripts/dev-local-workspace.mjs', '--data-root', data, '--build'], {
      cwd: product, env: {...process.env, npm_execpath: trampoline}, stdio: 'inherit',
    });
    const interrupt = () => launcher.kill('SIGINT');
    const terminate = () => launcher.kill('SIGTERM');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    try {
      await new Promise((resolve, reject) => {
        launcher.once('error', reject);
        launcher.once('close', (code, signal) => code === 0 && !signal ? resolve() : reject(new Error('Stock launcher build did not finish successfully')));
      });
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    }
    requireProduct(product);
    const {inputs, modules} = JSON.parse(fs.readFileSync(stage, 'utf8'));
    const files = await artifactFiles(output, modules);
    const receipt = {format: 1, inputs, inputs_sha256: fingerprint(inputs), modules, output_dir: output,
      files, output_sha256: fingerprint(files)};
    const content = `${JSON.stringify(receipt, null, 2)}\n`;
    fs.writeFileSync(receiptFile, content, {flag: 'wx', mode: 0o600});
    console.log(JSON.stringify({receipt_sha256: digest(content), output_sha256: receipt.output_sha256, inputs_sha256: receipt.inputs_sha256}));
  } finally {
    fs.rmSync(staging, {recursive: true, force: true});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).includes('--help')) console.log(usage);
  else {
    try { await run(process.argv.slice(2)); }
    catch (error) {
      const message = error?.message ?? '';
      console.error(/^(?:Usage:|Compiled build needs|Compiled trace requires|Product App must|Stock launcher build)/.test(message) ? message : 'Compiled build receipt could not be produced');
      process.exitCode = 1;
    }
  }
}
