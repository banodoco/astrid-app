// Entry-point fixtures only. Every writable path, process and remote is private.
// uname/installer/Runtime are doubles; git, pin.mjs and the release shell are real.
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shell = process.env.RELEASE_TOOL_UNDER_TEST || path.join(here, 'astrid-release');
const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
const realPython = spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim();
export const branch = 'release/14/fixture';
const sha = (letter) => letter.repeat(40);

export function put(file, value, mode = 0o600) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value, { mode });
}
const json = (file, value) => put(file, `${JSON.stringify(value, null, 2)}\n`);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function inventory(root) {
  const entries = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const info = statSync(file);
      entries.push([path.relative(root, file), info.isDirectory() ? 'directory' : digest(readFileSync(file))]);
      if (info.isDirectory()) walk(file);
    }
  };
  walk(root);
  return entries;
}

export function fixture(t, { installed = true, realm = true, savedPorts = '2400,17500,19501', installer = 'fail' } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'astrid-release-fixture-')));
  const home = path.join(dir, 'home');
  const root = path.join(home, 'astrid-release', branch.replaceAll('/', '-'));
  const bin = path.join(dir, 'bin');
  const remote = path.join(dir, 'remote');
  const events = path.join(dir, 'installer-events.jsonl');
  const configPath = path.join(dir, 'fixture.json');
  const env = { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: path.join(dir, 'tmp'), LANG: 'C', LC_ALL: 'C' };
  for (const name of [bin, env.TMPDIR, root, remote, path.join(root, 'state'), path.join(root, 'logs'), path.join(root, 'home'), path.join(root, 'tmp')]) mkdirSync(name, { recursive: true });
  const runGit = (args, cwd = remote) => {
    const r = spawnSync(realGit, args, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`fixture git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  let processChild;
  t.after(() => {
    if (processChild && processChild.exitCode === null) processChild.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });
  const config = { agent: sha('a'), runtime: sha('c'), installer, busy: [], freeKb: 100000000, remote, events, root };
  const writeConfig = () => json(configPath, config);
  writeConfig();
  const contract = { openapi: 'openapi.json', schemas: [] };
  const openapi = Buffer.from('{}\n');
  const contractName = Buffer.from('contract/openapi.json');
  const nameLength = Buffer.alloc(4); nameLength.writeUInt32BE(contractName.length);
  const dataLength = Buffer.alloc(8); dataLength.writeBigUInt64BE(BigInt(openapi.length));
  const schemaDigest = `sha256:${digest(Buffer.concat([nameLength, contractName, dataLength, openapi]))}`;
  const sources = { vibecomfy: { revision: sha('d') }, lifecycle: { revision: sha('e'), repository: 'https://github.com/banodoco/runpod-lifecycle', version: 'fixture' } };
  const manifest = { agent: { sha: config.agent }, runtime: { sha: config.runtime, schema_digest: schemaDigest }, vibecomfy: { sha: sources.vibecomfy.revision }, lifecycle: { repo: sources.lifecycle.repository, sha: sources.lifecycle.revision, version: sources.lifecycle.version }, tools: {} };
  json(path.join(remote, 'public/install-manifest.json'), manifest);
  json(path.join(remote, 'runtime.lock.json'), { source_commit: config.runtime });
  json(path.join(remote, 'package.json'), { engines: { node: '>=20' } });
  put(path.join(remote, 'package-lock.json'), '{}\n');
  put(path.join(remote, 'public/install'), `#!/bin/sh\nexec '${process.execPath}' '${path.join(dir, 'installer.mjs')}' "$@"\n`, 0o700);
  put(path.join(dir, 'installer.mjs'), `import fs from 'node:fs'; import path from 'node:path';
const c=JSON.parse(fs.readFileSync(${JSON.stringify(configPath)},'utf8'));
const args=process.argv.slice(2), at=(n)=>args[args.indexOf(n)+1];
const program=at('--root'), data=at('--data-root');
const old=fs.existsSync(c.events)?fs.readFileSync(c.events,'utf8').trim().split('\\n').filter(Boolean):[];
fs.appendFileSync(c.events,JSON.stringify({attempt:old.length+1,program:fs.existsSync(program),data:fs.existsSync(data),args})+'\\n');
fs.mkdirSync(program,{recursive:true}); fs.mkdirSync(path.join(data,'runtime/source-profiles'),{recursive:true});
fs.writeFileSync(path.join(program,'partial-program'),'keep until paired cleanup');
fs.writeFileSync(path.join(data,'runtime/source-profiles/astrid.json'),'{}');
if(c.protectOnFailure) fs.writeFileSync(path.join(c.root,'state/realm-id'),'fixture-realm\\n');
const retry=c.installer==='retry'&&old.length===0;
const report=path.join(process.env.HOME,'Library/Logs/Astrid Runtime/last-run.json');
fs.mkdirSync(path.dirname(report),{recursive:true});
fs.writeFileSync(report,JSON.stringify({exit_code:1,reason:retry?'network':'fixture complete',headline:'fixture installer',kind:'fixture'}));
console.log(retry?'ConnectionResetError: injected first-run network failure':'fixture: installer decision recorded'); process.exit(1);
`);
  runGit(['init', '--quiet', '-b', branch]);
  runGit(['add', '.']);
  runGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture App']);
  const appSha = runGit(['rev-parse', 'HEAD']);
  runGit(['clone', '--quiet', remote, path.join(root, 'editor')], dir);
  mkdirSync(path.join(root, 'editor/node_modules'));
  put(path.join(root, 'state/app-deps.sha256'), `${digest(Buffer.from('{}\n'))}\n`);
  put(path.join(root, 'state/heads.tsv'), `${branch} ${appSha} ${branch} ${config.agent}\n`);
  if (savedPorts !== null) put(path.join(root, 'state/ports'), `${savedPorts}\n`);
  if (realm) put(path.join(root, 'state/realm-id'), 'fixture-realm\n');
  put(path.join(root, 'data/edits.txt'), 'edits must survive\n');
  mkdirSync(path.join(home, 'live/runtime/realms/live'), { recursive: true });
  put(path.join(home, 'live/runtime/realms/live/realm.sqlite3'), 'fixture only\n');
  json(path.join(home, '.local/share/astrid/install.json'), { data_root: path.join(home, 'live') });
  if (installed) {
    put(path.join(root, 'program/current'), 'fixture-version\n');
    json(path.join(root, 'program/versions/fixture-version/manifest.json'), manifest);
    json(path.join(root, 'program/versions/fixture-version/version.json'), { env: { ASTRID_RUNTIME_DOOR_PORT: '19501' } });
    mkdirSync(path.join(root, 'program/versions/fixture-version/tools'), { recursive: true });
    put(path.join(root, 'program/versions/fixture-version/py/bin/python'), '#!/bin/sh\necho "fixture: Runtime handoff reached" >&2\nexit 73\n', 0o700);
  }
  // This loader serves exact synthetic Agent-lock/Runtime-contract bytes. Unknown URLs fail closed.
  put(path.join(dir, 'fetch.mjs'), `import fs from 'node:fs';
globalThis.fetch=async function(url){
 const c=JSON.parse(fs.readFileSync(${JSON.stringify(configPath)},'utf8')); const u=String(url);
 const agent='https://raw.githubusercontent.com/banodoco/astrid-agent/'+c.agent+'/';
 const runtime='https://raw.githubusercontent.com/banodoco/astrid-runtime/'+c.runtime+'/';
 const values={ [agent+'runtime.lock.json']:{source_commit:c.runtime}, [agent+'astrid/packs/runpod/pins.json']:{sources:${JSON.stringify(sources)}}, [runtime+'contract/manifest.json']:${JSON.stringify(contract)}, [runtime+'contract/openapi.json']:{} };
 if(!(u in values)) throw Error('fixture refused network URL: '+u);
 return new Response(JSON.stringify(values[u])+'\\n',{status:200});
};
`);
  put(path.join(bin, 'node'), `#!/bin/sh\nexec '${process.execPath}' --import '${path.join(dir, 'fetch.mjs')}' "$@"\n`, 0o700);
  put(path.join(bin, 'git'), `#!${realPython}
import json, os, sys
c=json.load(open(${JSON.stringify(configPath)})); args=sys.argv[1:]
if args[:2]==['ls-remote','--heads'] and args[2]=='https://github.com/banodoco/astrid-agent.git':
    if args[3]==${JSON.stringify(`refs/heads/${branch}`)}: print(c['agent']+'\\t'+args[3])
    sys.exit(0)
if args[:2]==['ls-remote','--heads'] and args[2]!='https://github.com/banodoco/astrid-app.git': sys.exit(0)
args=[c['remote'] if x=='https://github.com/banodoco/astrid-app.git' else x for x in args]
if any(x.startswith(('http://','https://','ssh://')) for x in args): raise SystemExit('fixture refused external git')
os.execv(${JSON.stringify(realGit)},[${JSON.stringify(realGit)}]+args)
`, 0o700);
  put(path.join(bin, 'lsof'), `#!${realPython}
import json,sys
c=json.load(open(${JSON.stringify(configPath)})); sys.exit(0 if any(x=='-iTCP:'+str(p) for x in sys.argv for p in c['busy']) else 1)
`, 0o700);
  put(path.join(bin, 'df'), `#!${realPython}
import json
c=json.load(open(${JSON.stringify(configPath)}))
print('Filesystem 1024-blocks Used Available Capacity Mounted on')
print('fixture 100000000 0 %s 0%% /' % c['freeKb'])
`, 0o700);
  for (const [name, body] of Object.entries({ uname: 'echo Darwin', sqlite3: 'echo "fixture: unexpected sqlite3" >&2; exit 91', npm: 'echo "fixture: unexpected npm" >&2; exit 91', launchctl: 'exit 0', sleep: 'exit 0' })) {
    put(path.join(bin, name), `#!/bin/sh\n${body}\n`, 0o700);
  }
  return {
    root, dir, home, config, writeConfig, manifest,
    moveApp: () => {
      put(path.join(remote, 'changed.txt'), 'new App code\n');
      runGit(['add', '.']);
      runGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'move fixture App']);
      return runGit(['rev-parse', 'HEAD']);
    },
    events: () => existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
    run: (command = 'up') => {
      const r = spawnSync('bash', [shell, ...(command === 'up' ? [] : [command]), branch], { env, cwd: dir, encoding: 'utf8', timeout: 20_000 });
      if (r.error) throw r.error;
      return { ...r, output: r.stdout + r.stderr };
    },
    startProcess: async () => {
      // stop_stack checks the real editor script basename before it sends any signal.
      const realScript = path.join(root, 'editor/scripts/dev-local-workspace.mjs');
      put(realScript, "process.send('ready'); setInterval(()=>{}, 1000);\n");
      processChild = spawn(process.execPath, [realScript], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      await new Promise((resolve, reject) => { processChild.once('message', resolve); processChild.once('error', reject); });
      const actualStart = spawnSync('ps', ['-p', `${processChild.pid}`, '-o', 'lstart='], { encoding: 'utf8' }).stdout.trim();
      put(path.join(root, 'state/processes.tsv'), `editor\t${processChild.pid}\t${actualStart}\n`);
      return () => {
        try { process.kill(processChild.pid, 0); } catch { return false; }
        const state = spawnSync('ps', ['-p', `${processChild.pid}`, '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
        const now = spawnSync('ps', ['-p', `${processChild.pid}`, '-o', 'lstart='], { encoding: 'utf8' }).stdout.trim();
        return !state.startsWith('Z') && now === actualStart;
      };
    },
  };
}
