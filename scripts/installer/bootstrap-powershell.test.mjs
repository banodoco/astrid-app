import assert from 'node:assert/strict';
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createPinnedRepo, failure, fixture, observe, preparation, repo, terminalInterrupt } from './fixture.mjs';
import { declaredSkip } from '../../scripts/quality/declared-skip.mjs';

// CI selects pwsh on POSIX and both Windows PowerShell 5.1 and pwsh on Windows.
const powershell = process.env.ASTRID_TEST_PWSH || 'pwsh';

async function assertLocalRequirement(localInstall, expectedPath, sha, suffix = '') {
  const requirement = localInstall.find((argument) => argument.startsWith('git+') && argument.endsWith(`@${sha}${suffix}`));
  assert.ok(requirement, JSON.stringify(localInstall));
  const pinned = suffix ? requirement.slice(4, -suffix.length) : requirement.slice(4);
  const revision = pinned.lastIndexOf('@');
  assert.equal(pinned.slice(revision + 1), sha);
  const actualPath = await canonicalTestPath(fileURLToPath(pinned.slice(0, revision)));
  const expected = await canonicalTestPath(expectedPath);
  assert.equal(process.platform === 'win32' ? actualPath.toLowerCase() : actualPath, process.platform === 'win32' ? expected.toLowerCase() : expected);
}

async function canonicalTestPath(value) {
  const resolved = path.resolve(value);
  try { return await realpath(resolved); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(await realpath(path.dirname(resolved)), path.basename(resolved));
  }
}

test('PowerShell opens install log appends with sharing compatible with the running service', async () => {
  const script = await readFile(path.join(repo, 'public/install.ps1'), 'utf8');
  assert.match(script, /new FileStream\(log, FileMode\.Append, FileAccess\.Write, FileShare\.ReadWrite \| FileShare\.Delete\)/);
  assert.doesNotMatch(script, /File\.AppendAllText\(log/);
});

test('PowerShell bootstrap source selects local manifest pins before download and forwards args in the child scope', async () => {
  const script = await readFile(path.join(repo, 'public/install.ps1'), 'utf8');
  const manifestScan = script.indexOf('for ($Index = 0; $Index -lt $InstallerArgs.Count; $Index++)');
  const download = script.indexOf('Invoke-WebRequest -UseBasicParsing $ManifestUrl -OutFile $Manifest');
  const pinRead = script.indexOf('Get-Content -Raw -Encoding UTF8 $Manifest | ConvertFrom-Json');
  const coreArgs = script.indexOf("$RunArgs = @('run', '--no-project'");
  const forwardArgs = script.indexOf('$RunArgs += $InstallerArgs');
  assert.ok(manifestScan >= 0 && download > manifestScan && pinRead > download && coreArgs > pinRead && forwardArgs > coreArgs);
  assert.match(script, /if \(-not \$ManifestProvided\) \{\s*\$ManifestUrl = if/s);
  assert.match(script, /if \(-not \$ManifestProvided\) \{ \$RunArgs \+= @\('--manifest', \$Manifest\) \}/);
  const outerBlock = script.indexOf('& {');
  const innerBlock = script.indexOf('param([bool]$FileInvocation)');
  assert.ok(outerBlock >= 0 && innerBlock > outerBlock);
  assert.doesNotMatch(script.slice(0, outerBlock), /\bparam\s*\(/);
  assert.match(script, /\} \(\[bool\]\$PSCommandPath -and \$MyInvocation\.MyCommand -is \[Management\.Automation\.ExternalScriptInfo\]\) @args\s*$/);
});

test('PowerShell bootstrap accepts unknown top-level manifest keys', () => scenario(async (context, run) => {
  context.manifest.release = 1;
  context.manifest.required = { release: 1, reason: 'Required update' };
  const result = await run();
  alive(result);
  assert.match(result.stdout, /Astrid is ready\./);
}));

test('PowerShell explains first-run preparation before Python setup completes', () => scenario(async (context) => {
  const harness = await context.powershell();
  const release = path.join(context.root, 'release-python');
  const child = await context.start(powershell, ['-NoProfile', '-NonInteractive', '-File', harness], { MOCK_PYTHON_RELEASE: release });
  const output = observe(child);
  try {
    await output.until(preparation);
    assert.equal(child.exitCode, null);
  } finally { await writeFile(release, 'continue'); }
  alive(await output.result);
}));

for (const architecture of ['PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432']) {
  test(`PowerShell refuses ARM64 via ${architecture} before downloads`, () => scenario(async (context, run) => {
    const result = await run([], architecture === 'PROCESSOR_ARCHITECTURE'
      ? { MOCK_PROCESSOR_ARCHITECTURE: 'ARM64', PROCESSOR_ARCHITECTURE: 'AMD64', PROCESSOR_ARCHITEW6432: '' }
      : { PROCESSOR_ARCHITECTURE: 'AMD64', PROCESSOR_ARCHITEW6432: 'ARM64' });
    alive(result);
    assert.match(result.stdout, /CAUGHT: Astrid does not support Windows ARM64 yet\./);
    assert.doesNotMatch(result.stdout, /Details:|Astrid could not get ready/);
    assert.deepEqual(await context.calls(), []);
    await assert.rejects(readFile(context.env.MOCK_FETCHED), { code: 'ENOENT' });
  }));
}

test('PowerShell -File reports ARM64 refusal as one sentence with a failure status', () => scenario(async (context) => {
  const result = await context.run(powershell, ['-NoProfile', '-NonInteractive', '-File', path.join(repo, 'public/install.ps1')], {
    PROCESSOR_ARCHITECTURE: 'AMD64', PROCESSOR_ARCHITEW6432: 'ARM64',
  });
  assert.equal(result.code, 1);
  assert.equal(result.stderr.trim(), 'Astrid does not support Windows ARM64 yet.');
  assert.equal(result.stdout.trim(), preparation);
  assert.deepEqual(await context.calls(), []);
}));

test('PowerShell preserves organization-policy guidance in the admitted log before downloads', () => scenario(async (context) => {
  const harness = await context.powershell();
  await writeFile(harness, `
function Get-ExecutionPolicy {
    param([switch]$List)
    [pscustomobject]@{ Scope = 'MachinePolicy'; ExecutionPolicy = 'Restricted' }
}
` + await readFile(harness, 'utf8'));
  const result = await context.run(powershell, ['-NoProfile', '-NonInteractive', '-File', harness]);
  alive(result);
  assert.match(result.stdout, /CAUGHT: Astrid couldn't finish\. Your work is kept\./);
  assert.match(await readFile(context.env.MOCK_LOG, 'utf8'), /Process-level Bypass cannot override Group Policy/);
  assert.deepEqual(await context.calls(), []);
  await assert.rejects(readFile(context.env.MOCK_FETCHED), { code: 'ENOENT' });
}));

test('PowerShell decodes UTF-8 stdout and stderr and enables isolated Python UTF-8 mode', () => scenario(async (context, run) => {
  const result = await run([], { MOCK_UNICODE_OUTPUT: '1' });
  alive(result);
  assert.match(result.stdout, /Workspace: 测试\/Zoë/);
  assert.match(await readFile(context.env.MOCK_LOG, 'utf8'), /Diagnostic: 测试\/Zoë/);
  const args = (await context.calls()).at(-1);
  assert.deepEqual(args.slice(args.indexOf('python') + 1, args.indexOf('-m')), ['-u', '-I', '-X', 'utf8']);
}));

// Exercise the Windows branch on Linux. Only the native SID lookup, Win32
// creation call and ACL observations are faked; production admission runs.
async function windowsDirectories(context, env = {}) {
  const harness = await context.powershell();
  let script = await readFile(path.join(repo, 'public/install.ps1'), 'utf8');
  if (process.platform !== 'win32') {
    script = script.replace('$PowerShell = Join-Path $PSHOME $PowerShellName', '$PowerShell = (Get-Process -Id $PID).Path');
  }
  script = script
    .replace('[Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT', '$false')
    .replace('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value', "'S-1-5-21-1234'");
  const target = path.join(context.root, 'windows-bootstrap.ps1');
  await writeFile(target, script);
  context.env.MOCK_INSTALL_SCRIPT = target;
  context.env.MOCK_PRIVATE_DIRS = path.join(context.root, 'private-dirs');
  const bootstrap = path.join(context.env.LOCALAPPDATA, 'Astrid Installer/bootstrap');
  await mkdir(bootstrap, { recursive: true });
  const bootstrapUv = path.join(bootstrap, 'uv.exe');
  if (path.resolve(context.env.MOCK_UV_SOURCE) !== path.resolve(bootstrapUv)) {
    await cp(context.env.MOCK_UV_SOURCE, bootstrapUv);
  }
  const prelude = `
Add-Type -TypeDefinition @'
using System;
using System.IO;
public static class AstridInstallerDirectoryV1 {
    public static void Create(string path, string sddl) {
        File.AppendAllText(Environment.GetEnvironmentVariable("MOCK_PRIVATE_DIRS"), path + "\\t" + sddl + "\\n");
        Directory.CreateDirectory(path);
    }
}
'@
function Get-Item {
    param([switch]$Force, [string]$LiteralPath)
    [pscustomobject]@{ Attributes = if ($env:MOCK_ACL_FAILURE -eq 'reparse') { [IO.FileAttributes]::ReparsePoint } elseif ($env:MOCK_ACL_FAILURE -eq 'file') { [IO.FileAttributes]::Normal } else { [IO.FileAttributes]::Directory } }
}
function Get-Acl {
    param([string]$LiteralPath)
    $Acl = [pscustomobject]@{
        AreAccessRulesProtected = $env:MOCK_ACL_FAILURE -ne 'inherited'
        Sddl = if ($env:MOCK_ACL_FAILURE -eq 'unknown-ace') { 'D:P(XA;;FA;;;WD)' } else { 'D:P(A;OICI;FA;;;S-1-5-21-1234)(A;OICI;FA;;;SY)' }
    }
    $Acl | Add-Member ScriptMethod GetOwner {
        param($Type)
        [pscustomobject]@{ Value = if ($env:MOCK_ACL_FAILURE -eq 'foreign-owner') { 'S-1-5-21-9999' } else { 'S-1-5-21-1234' } }
    }
    $Acl | Add-Member ScriptMethod GetAccessRules {
        param($Explicit, $Inherited, $Type)
        foreach ($Trustee in @('S-1-5-21-1234', 'S-1-5-18')) {
            [pscustomobject]@{
                IdentityReference = [pscustomobject]@{ Value = if ($env:MOCK_ACL_FAILURE -eq 'everyone') { 'S-1-1-0' } else { $Trustee } }
                AccessControlType = if ($env:MOCK_ACL_FAILURE -eq 'deny') { [Security.AccessControl.AccessControlType]::Deny } else { [Security.AccessControl.AccessControlType]::Allow }
                PropagationFlags = if ($env:MOCK_ACL_FAILURE -eq 'inherit-only') { [Security.AccessControl.PropagationFlags]::InheritOnly } else { [Security.AccessControl.PropagationFlags]::None }
            }
        }
    }
    $Acl
}
`;
  await writeFile(harness, prelude + await readFile(harness, 'utf8'));
  return context.run(powershell, ['-NoProfile', '-NonInteractive', '-File', harness], env);
}

test('PowerShell creates only Astrid roots with protected owner/SYSTEM ACLs before downloads', () => scenario(async (context) => {
  const result = await windowsDirectories(context);
  alive(result);
  assert.match(result.stdout, /Astrid is ready\./);
  const records = (await readFile(context.env.MOCK_PRIVATE_DIRS, 'utf8')).trim().split('\n').map((line) => line.split('\t'));
  assert.deepEqual(records.slice(0, 4).map(([directory]) => directory), [
    path.join(context.env.LOCALAPPDATA, 'Astrid Installer'), path.join(context.env.LOCALAPPDATA, 'Astrid Installer/bootstrap'),
    path.join(context.env.LOCALAPPDATA, 'Astrid Runtime'), path.join(context.env.LOCALAPPDATA, 'Astrid Runtime/logs'),
  ]);
  assert.equal(records.length, 5);
  for (const [directory, sddl] of records) {
    assert.notEqual(directory, context.env.LOCALAPPDATA);
    assert.equal(sddl, 'O:S-1-5-21-1234D:P(A;OICI;FA;;;S-1-5-21-1234)(A;OICI;FA;;;SY)');
  }
}));

for (const failure of ['inherited', 'foreign-owner', 'everyone', 'deny', 'unknown-ace', 'inherit-only', 'reparse', 'file']) {
  test(`PowerShell rejects ${failure} Windows directory security before writing or downloading`, () => scenario(async (context) => {
    const result = await windowsDirectories(context, { MOCK_ACL_FAILURE: failure });
    alive(result);
    assert.match(result.stdout, /CAUGHT: Astrid directories (require|must be)/);
    assert.doesNotMatch(result.stdout, /Details:/);
    assert.deepEqual(await context.calls(), []);
    await assert.rejects(readFile(context.env.MOCK_FETCHED), { code: 'ENOENT' });
    await assert.rejects(readFile(context.env.MOCK_LOG), { code: 'ENOENT' });
  }));
}

test('PowerShell uses a fresh process helper after an older bootstrap ran in the same session', () => scenario(async (context) => {
  const harness = await context.powershell();
  let script = await readFile(harness, 'utf8');
  script = script.replace("$ErrorActionPreference = 'Continue'", `$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @'
using System.Diagnostics;
public sealed class AstridInstallerProcessV3 {
    public static int OldVersion = 1;
}
'@`);
  await writeFile(harness, script);
  const result = await context.run(powershell, ['-NoProfile', '-NonInteractive', '-File', harness]);
  alive(result);
  assert.match(result.stdout, /Astrid is ready\./);
  assert.doesNotMatch(result.stdout, /CAUGHT:/);
}));

async function scenario(fn) {
  const context = await fixture();
  try {
    const harness = await context.powershell();
    await fn(context, (args = [], env = {}) => context.run(powershell, ['-NoProfile', '-NonInteractive', '-File', harness], {
      ...env,
      MOCK_INSTALLER_ARGS: args.map((argument) => `x${Buffer.from(argument, 'utf8').toString('base64')}`).join(','),
    }));
  } finally { await context.cleanup(); }
}
function alive(result) {
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /SHELL-ALIVE/);
  assert.match(result.stdout, /PREFERENCE: Continue/);
}

test('PowerShell tolerates native stderr, forwards arguments and avoids Python shims/registry', () => scenario(async (context, run) => {
  context.manifest.agent.repo = path.join(context.root, 'source with spaces');
  context.manifest.runtime.repo = pathToFileURL(path.join(context.root, 'runtime source')).href;
  const committedSource = '# committed source\n';
  context.manifest.agent.sha = await createPinnedRepo(context.manifest.agent.repo, committedSource);
  await writeFile(path.join(context.manifest.agent.repo, 'source-marker.txt'), '# changed checkout source\n');
  const flags = ['--update', '--data-root', '/a path/with spaces', 'embedded"quote', 'trailing slash\\', '--managed-by', 'pinokio', '--root', '/Pinokio Apps/Astrid'];
  const result = await run(flags);
  alive(result);
  assert.match(result.stdout, /Astrid is ready\./);
  assert.doesNotMatch(result.stdout, /CAUGHT:/);
  assert.equal(await readFile(context.env.MOCK_FETCHED, 'utf8'), context.env.ASTRID_INSTALL_MANIFEST_URL);
  const calls = await context.calls();
  assert.deepEqual(calls.find((args) => args[0] === 'python'), ['python', 'install', '3.11.13', '--no-bin', '--no-registry']);
  const core = calls.at(-1);
  assert.deepEqual(core.slice(-flags.length), flags);
  assert.equal(calls.filter((args) => args[0] === 'pip').length, 1, 'bootstrap installs first-party packages once');
  assert.ok(calls.every((args) => !args.includes('--require-hashes')), 'bootstrap must not install third-party dependencies');
  const localInstall = calls.find((args) => args[0] === 'pip' && args.includes('--no-deps'));
  assert.ok(localInstall, 'pinned local packages must be installed without resolving dependencies');
  await assertLocalRequirement(localInstall, path.join(context.root, 'runtime source'), context.manifest.runtime.sha, '#subdirectory=packages/python');
  await assertLocalRequirement(localInstall, path.join(context.root, 'source with spaces'), context.manifest.agent.sha);
  assert.ok(localInstall.some((arg) => arg.endsWith('#subdirectory=packages/python')), JSON.stringify(localInstall));
  assert.ok(!core.includes('--with'));
  assert.match(await readFile(context.env.MOCK_LOG, 'utf8'), /native progress on stderr/);
}));

for (const manifestFlag of ['--manifest', '--manifest=']) {
  test(`PowerShell uses a supplied local manifest (${manifestFlag}) for bootstrap pins and core without downloading`, () => scenario(async (context, run) => {
    const localManifest = path.join(context.root, 'local manifest.json');
    const localPins = structuredClone(context.manifest);
    localPins.agent.sha = 'a'.repeat(40);
    localPins.runtime.sha = 'b'.repeat(40);
    await writeFile(localManifest, JSON.stringify(localPins));
    const supplied = manifestFlag === '--manifest' ? [manifestFlag, localManifest] : [`${manifestFlag}${localManifest}`];
    const managerArgs = ['--managed-by', 'pinokio', '--root', '/Pinokio Apps/Astrid'];
    const result = await run([...managerArgs, ...supplied]);
    alive(result);
    assert.doesNotMatch(result.stdout, /CAUGHT:/, result.stdout);
    assert.match(result.stdout, /Astrid is ready\./, result.stdout);
    await assert.rejects(readFile(context.env.MOCK_FETCHED), { code: 'ENOENT' });
    const core = (await context.calls()).at(-1);
    assert.ok(core, 'the installer must run the core after reading a supplied manifest');
    assert.deepEqual(core.slice(-managerArgs.length - supplied.length), [...managerArgs, ...supplied]);
    assert.equal(core.filter((argument) => argument === '--manifest' || argument.startsWith('--manifest=')).length, 1);
    const localInstall = (await context.calls()).find((args) => args[0] === 'pip' && args.includes('--no-deps'));
    assert.ok(localInstall.includes(`https://github.com/banodoco/astrid-agent/archive/${localPins.agent.sha}.tar.gz`));
    assert.ok(localInstall.includes(`https://github.com/banodoco/astrid-runtime/archive/${localPins.runtime.sha}.tar.gz#subdirectory=packages/python`));
  }));
}

test('PowerShell scriptblock invocation forwards --update and Pinokio root arguments without binding them as bootstrap parameters', () => scenario(async (context) => {
  const harness = await context.powershell();
  await writeFile(harness, `
$ErrorActionPreference = 'Continue'
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, [Parameter(Position=0)][string]$Uri, [string]$OutFile)
    if ($Uri.StartsWith('https://astral.sh/')) {
        [IO.File]::WriteAllText($OutFile, @'
Copy-Item -LiteralPath $env:MOCK_UV_SOURCE -Destination (Join-Path $env:UV_UNMANAGED_INSTALL 'uv.exe') -Force
'@)
    } else {
        Copy-Item $env:MOCK_MANIFEST $OutFile
    }
}
function irm { param([string]$Uri) [IO.File]::ReadAllText($env:MOCK_INSTALL_SCRIPT) }
try {
    & ([scriptblock]::Create((irm https://astrid.haus/install.ps1))) --update --managed-by pinokio --root '/Pinokio Apps/Astrid'
} catch { [Console]::WriteLine('CAUGHT: ' + $_.Exception.Message) }
[Console]::WriteLine('SHELL-ALIVE')
[Console]::WriteLine('PREFERENCE: ' + $ErrorActionPreference)
[Console]::WriteLine('NATIVE-STATUS: ' + $global:LASTEXITCODE)
`);
  const result = await context.run(powershell, ['-NoProfile', '-NonInteractive', '-File', harness]);
  alive(result);
  assert.doesNotMatch(result.stdout, /CAUGHT:/);
  const core = (await context.calls()).at(-1);
  assert.deepEqual(core.slice(-5), ['--update', '--managed-by', 'pinokio', '--root', '/Pinokio Apps/Astrid']);
}));

test('PowerShell defaults to hosted manifest and exact hosted source pins', () => scenario(async (context, run) => {
  const result = await run([], { ASTRID_INSTALL_MANIFEST_URL: '' });
  alive(result);
  assert.doesNotMatch(result.stdout, /CAUGHT:/);
  assert.equal(await readFile(context.env.MOCK_FETCHED, 'utf8'), 'https://astrid.haus/install-manifest.json');
  const localInstall = (await context.calls()).find((args) => args[0] === 'pip' && args.includes('--no-deps'));
  for (const name of ['runtime', 'agent']) assert.ok(localInstall.includes(`https://github.com/banodoco/astrid-${name}/archive/${context.manifest[name].sha}.tar.gz`));
}));

for (const repoValue of ['relative/path', '', null, 'https://example.com/source', 'file://remote/tmp/repo', 'file:///tmp/repo?branch=main', 'file:///tmp/repo#main', 'file://user@localhost/tmp/repo', 'file://localhost:123/tmp/repo', 'file://localhost:-1/tmp/repo', 'file://localhost', String.raw`\\server\share\repo`]) {
  test(`PowerShell rejects invalid developer source ${JSON.stringify(repoValue)} without closing iex shell`, () => scenario(async (context, run) => {
    context.manifest.agent.repo = repoValue;
    const result = await run();
    alive(result);
    assert.equal((result.stdout.match(/Astrid couldn't finish\. Your work is kept\./g) || []).length, 1);
    assert.equal((result.stdout.match(/Details:/g) || []).length, 1);
    assert.equal((await context.calls()).filter((args) => args.includes('--with')).length, 0);
  }));
}

test('PowerShell rejects invalid commit pins before core', () => scenario(async (context, run) => {
  context.manifest.agent.sha = 'ABCDEF'.repeat(6) + 'ABCD';
  const result = await run();
  alive(result);
  assert.match(result.stdout, /CAUGHT: Astrid couldn't finish\. Your work is kept\./);
  assert.equal((await context.calls()).filter((args) => args.includes('--with')).length, 0);
}));

test('PowerShell rejects mismatching bootstrap pins without preparing Python', () => scenario(async (context, run) => {
  context.manifest.tools.uv.version = '0.8.22';
  const result = await run();
  alive(result);
  assert.match(result.stdout, /CAUGHT: Astrid couldn't finish\. Your work is kept\./);
  assert.deepEqual(await context.calls(), []);
}));

for (const env of [{ MOCK_FETCH_EXIT: '7' }, { MOCK_PYTHON_EXIT: '17' }]) {
  test(`PowerShell reports one pre-core failure for ${JSON.stringify(env)} and keeps iex shell`, () => scenario(async (context, run) => {
    const result = await run([], env);
    alive(result);
    assert.equal((result.stdout.match(/Astrid couldn't finish\. Your work is kept\./g) || []).length, 1);
    assert.equal((result.stdout.match(/Details:/g) || []).length, 1);
  }));
}

test('PowerShell preserves one core failure paragraph and keeps iex shell', () => scenario(async (context, run) => {
  const result = await run([], { MOCK_CORE_EXIT: '23' });
  alive(result);
  assert.ok(result.stdout.includes(`CAUGHT: ${failure}`));
  assert.match(result.stdout, /NATIVE-STATUS: 23/);
  assert.equal(result.stdout.split(failure).length - 1, 1);
  assert.equal((result.stdout.match(/Details:/g) || []).length, 1);
  assert.doesNotMatch(result.stdout, /Astrid could not get ready/);
}));

test('PowerShell preserves the installer low-space failure without adding a second error', () => scenario(async (context, run) => {
  const result = await run([], { MOCK_CORE_DISK_FAILURE: '1' });
  alive(result);
  assert.equal((result.stdout.match(/Astrid couldn't finish\. Your work is kept\./g) || []).length, 1);
  assert.match(result.stdout, /Your work is kept\.\r?\nThere is not enough free disk space to back up your workspace\.\r?\nDetails:/);
  assert.equal((result.stdout.match(/Details:/g) || []).length, 1);
  assert.doesNotMatch(result.stdout, /Astrid could not get ready/);
}));

test('PowerShell preserves output after uninstall removes bootstrap', () => scenario(async (context, run) => {
  const result = await run(['--uninstall'], process.platform === 'win32' ? {} : { MOCK_REMOVE_BOOTSTRAP: '1' });
  alive(result);
  assert.match(result.stdout, /Astrid was uninstalled\./);
  assert.doesNotMatch(result.stdout, /CAUGHT:/);
  await assert.rejects(readFile(path.join(context.env.LOCALAPPDATA, 'Astrid Installer/bootstrap/uv.exe')), { code: 'ENOENT' });
}));

test('PowerShell removes its external bootstrap and lock after successful uninstall, repeatedly', () => scenario(async (context, run) => {
  const installerRoot = path.join(context.env.LOCALAPPDATA, 'Astrid Installer');
  for (let attempt = 0; attempt < 2; attempt++) {
    const ready = await run();
    alive(ready);
    await writeFile(path.join(installerRoot, 'astrid-install.lock'), 'held by core until it exits');
    const result = await run(['--uninstall']);
    alive(result);
    assert.match(result.stdout, /Astrid was uninstalled\./);
    assert.doesNotMatch(result.stdout, /CAUGHT:|Remove-Item/);
    await assert.rejects(readFile(path.join(installerRoot, 'bootstrap/uv.exe')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(installerRoot, 'astrid-install.lock')), { code: 'ENOENT' });
    await assert.rejects(readFile(installerRoot), { code: 'ENOENT' });
  }
}));

test('PowerShell keeps the bootstrap when uninstall fails', () => scenario(async (context, run) => {
  const result = await run(['--uninstall'], { MOCK_CORE_EXIT: '23' });
  alive(result);
  assert.match(result.stdout, /NATIVE-STATUS: 23/);
  assert.ok((await readFile(path.join(context.env.LOCALAPPDATA, 'Astrid Installer/bootstrap/uv.exe'))).length);
}));

test('PowerShell retries installer-root cleanup after transient sharing failures', () => scenario(async (context, run) => {
  const harness = await context.powershell();
  await writeFile(harness, `
function Remove-Item {
    param([string]$LiteralPath, [switch]$Recurse, [switch]$Force, [Parameter(Position=0)][string]$Path)
    if ($LiteralPath -eq (Join-Path $env:LOCALAPPDATA 'Astrid Installer')) {
        $Count = 0
        if (Test-Path $env:MOCK_CLEANUP_ATTEMPTS) { $Count = [int](Get-Content $env:MOCK_CLEANUP_ATTEMPTS -Raw) }
        $Count++
        Set-Content -Path $env:MOCK_CLEANUP_ATTEMPTS -Value $Count -NoNewline
        if ($Count -lt 3) { throw 'bootstrap remained temporarily locked after core exit' }
    }
    Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $(if ($LiteralPath) { $LiteralPath } else { $Path }) -Recurse -Force -ErrorAction SilentlyContinue
}
` + await readFile(harness, 'utf8'));
  context.env.MOCK_CLEANUP_ATTEMPTS = path.join(context.root, 'cleanup-attempts');
  const result = await run(['--uninstall']);
  alive(result);
  assert.match(result.stdout, /NATIVE-STATUS: 0/);
  assert.equal(await readFile(context.env.MOCK_CLEANUP_ATTEMPTS, 'utf8'), '3');
  await assert.rejects(readFile(path.join(context.env.LOCALAPPDATA, 'Astrid Installer')), { code: 'ENOENT' });
  assert.doesNotMatch(result.stdout, /CAUGHT:|Remove-Item/);
}));

test('PowerShell reports installer residue after cleanup retries without failing a successful uninstall', () => scenario(async (context, run) => {
  const harness = await context.powershell();
  await writeFile(harness, `
function Remove-Item {
    param([string]$LiteralPath, [switch]$Recurse, [switch]$Force, [Parameter(Position=0)][string]$Path)
    if ($LiteralPath -eq (Join-Path $env:LOCALAPPDATA 'Astrid Installer')) {
        $Count = 0
        if (Test-Path $env:MOCK_CLEANUP_ATTEMPTS) { $Count = [int](Get-Content $env:MOCK_CLEANUP_ATTEMPTS -Raw) }
        $Count++
        Set-Content -Path $env:MOCK_CLEANUP_ATTEMPTS -Value $Count -NoNewline
        throw 'bootstrap remained locked after core exit'
    }
    Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $(if ($LiteralPath) { $LiteralPath } else { $Path }) -Recurse -Force -ErrorAction SilentlyContinue
}
` + await readFile(harness, 'utf8'));
  context.env.MOCK_CLEANUP_ATTEMPTS = path.join(context.root, 'cleanup-attempts');
  const result = await run(['--uninstall']);
  alive(result);
  assert.match(result.stdout, /NATIVE-STATUS: 0/);
  assert.equal(await readFile(context.env.MOCK_CLEANUP_ATTEMPTS, 'utf8'), '4');
  assert.ok(result.stdout.includes(`Astrid was uninstalled. Remove ${path.join(context.env.LOCALAPPDATA, 'Astrid Installer')} after closing this window.`));
  assert.doesNotMatch(result.stdout, /CAUGHT:|Details:|couldn't finish/);
}));

test('PowerShell -File reports a nonzero process status on a pre-core failure', () => scenario(async (context) => {
  const result = await context.run(powershell, ['-NoProfile', '-NonInteractive', '-File', path.join(repo, 'public/install.ps1')]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Astrid couldn't finish\. Your work is kept\./);
}));

test('PowerShell drains simultaneous multi-megabyte native output without deadlock', () => scenario(async (context, run) => {
  const result = await run([], { MOCK_VOLUME_BYTES: '4194304' });
  alive(result);
  assert.match(result.stdout, /Astrid is ready\./);
  assert.doesNotMatch(result.stdout, /CAUGHT:/);
  const log = await readFile(context.env.MOCK_LOG, 'utf8');
  assert.ok(log.includes('o'.repeat(4194304)));
  assert.ok(log.includes('e'.repeat(4194304)));
}));

test('PowerShell handles stderr progress from native uv bootstrap setup', () => scenario(async (context, run) => {
  const bootstrapUv = path.join(context.env.LOCALAPPDATA, 'Astrid Installer/bootstrap/uv.exe');
  context.env.MOCK_BOOTSTRAP_ARGS = path.join(context.root, 'bootstrap-args.json');
  if (process.platform !== 'win32') {
    context.env.SystemRoot = path.join(context.root, 'system root');
    context.env.MOCK_SOURCE_UV = path.join(context.root, 'uv-source.exe');
    await cp(context.env.MOCK_UV_SOURCE, context.env.MOCK_SOURCE_UV);
    await rm(bootstrapUv, { force: true });
    await assert.rejects(readFile(bootstrapUv), { code: 'ENOENT' });
    const installScript = (await readFile(path.join(repo, 'public/install.ps1'), 'utf8'))
      .replace('Join-Path $PSHOME $PowerShellName', 'Join-Path $env:SystemRoot $PowerShellName');
    const scriptPath = path.join(context.root, 'install-current-shell.ps1');
    await writeFile(scriptPath, installScript);
    context.env.MOCK_INSTALL_SCRIPT = scriptPath;
    const executable = path.join(context.env.SystemRoot, 'pwsh.exe');
    const incompatibleExecutable = path.join(context.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    await mkdir(context.env.SystemRoot, { recursive: true });
    await mkdir(path.dirname(incompatibleExecutable), { recursive: true });
    await writeFile(incompatibleExecutable, `#!/usr/bin/env python3
import sys
print('Microsoft.PowerShell.Security could not load from inherited PSModulePath', file=sys.stderr)
sys.exit(1)
`, { mode: 0o755 });
    await writeFile(executable, `#!/usr/bin/env python3
import json, os, pathlib, shutil, sys
pathlib.Path(os.environ['MOCK_BOOTSTRAP_ARGS']).write_text(json.dumps(sys.argv[1:]))
print('bootstrap progress on stderr', file=sys.stderr)
shutil.copy2(os.environ['MOCK_SOURCE_UV'], pathlib.Path(os.environ['UV_UNMANAGED_INSTALL']) / 'uv.exe')
`, { mode: 0o755 });
  } else {
    await rm(bootstrapUv, { force: true });
    await assert.rejects(readFile(bootstrapUv), { code: 'ENOENT' });
    context.env.MOCK_BOOTSTRAP_STDERR = '1';
  }
  const result = await run();
  alive(result);
  assert.match(result.stdout, /Astrid is ready\./);
  assert.doesNotMatch(result.stdout, /CAUGHT:/);
  const encodedArgs = await readFile(context.env.MOCK_BOOTSTRAP_ARGS, 'utf8');
  const args = process.platform === 'win32' ? encodedArgs.split(/\r?\n/) : JSON.parse(encodedArgs);
  assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.match(args[5], /uv\.ps1$/);
  assert.match(await readFile(context.env.MOCK_LOG, 'utf8'), /bootstrap progress on stderr/);
}));

for (const coreExit of ['0', '23']) {
  test(`PowerShell -File fetches real HTTP manifest and reports core status ${coreExit}`, () => scenario(async (context) => {
    const prepared = await context.run(powershell, ['-NoProfile', '-NonInteractive', '-File', path.join(context.root, 'invoke.ps1')]);
    alive(prepared);
    context.manifest.agent.repo = path.join(context.root, 'http source');
    const committedSource = '# committed HTTP source\n';
    context.manifest.agent.sha = await createPinnedRepo(context.manifest.agent.repo, committedSource);
    await writeFile(path.join(context.manifest.agent.repo, 'source-marker.txt'), '# changed checkout source\n');
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(context.manifest));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(process.env.ASTRID_TEST_INSTALLER_HTTP_PORT || 0), '127.0.0.1', resolve);
    });
    try {
      const flags = ['--update', '--data-root', '/a path/with spaces', 'embedded"quote', 'trailing slash\\'];
      const result = await context.run(powershell, ['-NoProfile', '-NonInteractive', '-File', path.join(repo, 'public/install.ps1'), ...flags], {
        ASTRID_INSTALL_MANIFEST_URL: `http://127.0.0.1:${server.address().port}/install-manifest.json`,
        ...(coreExit === '0' ? {} : { MOCK_CORE_EXIT: coreExit }),
      });
      if (coreExit === '0') {
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /Astrid is ready\./);
      } else {
        assert.equal(result.code, 23);
        assert.match(result.stderr, /Astrid couldn't finish\. Your work is kept\./);
        assert.doesNotMatch(result.stderr, /Astrid could not get ready/);
      }
      assert.deepEqual((await context.calls()).at(-1).slice(-flags.length), flags);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }));
}

test('PowerShell also accepts uv version output without build metadata', () => scenario(async (_context, run) => {
  const result = await run([], { MOCK_UV_VERSION: 'uv 0.11.32' });
  alive(result);
  assert.match(result.stdout, /Astrid is ready\./);
  assert.doesNotMatch(result.stdout, /CAUGHT:/);
}));

test('PowerShell accepts localhost file URLs as local pinned repositories', () => scenario(async (context, run) => {
  const repoPath = path.join(context.root, 'local source with spaces');
  const local = pathToFileURL(repoPath).href;
  context.manifest.agent.repo = local.replace('file:///', 'file://localhost/');
  const committedSource = '# committed local source\n';
  context.manifest.agent.sha = await createPinnedRepo(repoPath, committedSource);
  await writeFile(path.join(repoPath, 'source-marker.txt'), '# changed checkout source\n');
  const result = await run();
  alive(result);
  assert.match(result.stdout, /Astrid is ready\./);
  assert.doesNotMatch(result.stdout, /CAUGHT:/);
  const localInstall = (await context.calls()).find((args) => args[0] === 'pip' && args.includes('--no-deps'));
  await assertLocalRequirement(localInstall, repoPath, context.manifest.agent.sha);
}));

test('PowerShell streams an unbuffered installer stage before the transaction can finish', () => scenario(async (context) => {
  const harness = await context.powershell();
  const release = path.join(context.root, 'release-stage');
  const child = await context.start(powershell, ['-NoProfile', '-NonInteractive', '-File', harness], { MOCK_STAGE_RELEASE: release });
  const output = observe(child);
  try {
    await output.until('Installing Astrid.');
    assert.equal(child.exitCode, null);
  } finally { await writeFile(release, 'continue'); }
  const result = await output.result;
  alive(result);
  assert.match(result.stdout, /Astrid is ready\./);
  assert.match(result.stdout, /NATIVE-STATUS: 0/);
  assert.ok((await context.calls()).at(-1).includes('-u'));
}));

test('PowerShell preserves native core failure status without closing the scriptblock caller', () => scenario(async (_context, run) => {
  const result = await run(['--update'], { MOCK_CORE_EXIT: '31' });
  alive(result);
  assert.match(result.stdout, /NATIVE-STATUS: 31/);
  assert.equal(result.stdout.split(failure).length - 1, 1);
  assert.equal((result.stdout.match(/Details:/g) || []).length, 1);
}));

test('PowerShell preserves a native core failure status and logs diagnostics before the core paragraph', () => scenario(async (context, run) => {
  const result = await run([], { MOCK_CORE_RAW_EXIT: '27' });
  alive(result);
  assert.match(result.stdout, /NATIVE-STATUS: 27/);
  assert.equal((result.stdout.match(/Astrid couldn't finish\. Your work is kept\./g) || []).length, 1);
  assert.equal((result.stdout.match(/Details:/g) || []).length, 1);
  assert.match(await readFile(context.env.MOCK_LOG, 'utf8'), /raw core diagnostic/);
}));

test('PowerShell console interruption reaches the child and waits for recovery', { skip: declaredSkip('windows-console-interruption-harness') }, () => scenario(async (context) => {
  const harness = await context.powershell();
  const receipt = path.join(context.root, 'interrupted');
  const result = await context.run('python3', ['-c', terminalInterrupt, powershell, '-NoProfile', '-NonInteractive', '-File', harness], {
    MOCK_STAGE_RELEASE: path.join(context.root, 'never-release'), MOCK_INTERRUPTED: receipt,
  }, 120_000);
  assert.equal(result.code, 0, result.stderr);
  const terminal = JSON.parse(result.stdout);
  assert.equal(terminal.interrupted, true);
  assert.match(await readFile(receipt, 'utf8'), /KeyboardInterrupt reached installer/);
  assert.equal(terminal.output.split(failure).length - 1, 1, terminal.output);
  assert.equal((terminal.output.match(/Details:/g) || []).length, 1, terminal.output);
}));

test('PowerShell leaves the shared log available to the running core and retains both diagnostics', () => scenario(async (context, run) => {
  const result = await run([], { MOCK_CORE_APPEND_LOG: '1', MOCK_CORE_EXIT: '23' });
  alive(result);
  assert.match(result.stdout, /Core is writing its log\./);
  assert.match(result.stdout, /NATIVE-STATUS: 23/);
  assert.equal(result.stdout.split(failure).length - 1, 1);
  const log = await readFile(context.env.MOCK_LOG, 'utf8');
  assert.match(log, /core opened its own log/);
  assert.match(log, /core kept its own diagnostic/);
  assert.match(log, /native progress on stderr/);
}));

test('PowerShell command configuration inherits the console used to deliver Ctrl+C', () => scenario(async (context) => {
  const unit = path.join(context.root, 'console-forwarding.ps1');
  await writeFile(unit, `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System.Diagnostics;
public class AstridInstallerProcessV4 {
    public static ProcessStartInfo Run(ProcessStartInfo info, string log, bool logOutput, bool streamOutput) { return info; }
}
'@
$Tokens = $null
$Errors = $null
$Ast = [Management.Automation.Language.Parser]::ParseFile($env:MOCK_INSTALL_SCRIPT, [ref]$Tokens, [ref]$Errors)
if ($Errors) { throw $Errors[0] }
$Function = $Ast.Find({ param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Invoke-InstallerCommand' }, $true)
Invoke-Expression $Function.Extent.Text
$Log = $env:MOCK_LOG
$Info = Invoke-InstallerCommand 'native-child' @('python','-u','-I','-m','astrid','install') -StreamOutput
[Console]::WriteLine(($Info | Select-Object UseShellExecute, CreateNoWindow, RedirectStandardInput, RedirectStandardOutput, RedirectStandardError, Arguments, @{Name='StandardOutputEncoding';Expression={$_.StandardOutputEncoding.WebName}}, @{Name='StandardErrorEncoding';Expression={$_.StandardErrorEncoding.WebName}} | ConvertTo-Json -Compress))
`);
  const result = await context.run(powershell, ['-NoProfile', '-NonInteractive', '-File', unit]);
  assert.equal(result.code, 0, result.stderr);
  const info = JSON.parse(result.stdout);
  assert.equal(info.UseShellExecute, false);
  assert.equal(info.CreateNoWindow, false);
  assert.equal(info.RedirectStandardInput, false);
  assert.equal(info.RedirectStandardOutput, true);
  assert.equal(info.RedirectStandardError, true);
  assert.equal(info.StandardOutputEncoding, 'utf-8');
  assert.equal(info.StandardErrorEncoding, 'utf-8');
  assert.equal(info.Arguments, '"python" "-u" "-I" "-m" "astrid" "install"');
}));
