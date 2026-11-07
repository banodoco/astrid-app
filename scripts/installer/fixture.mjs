import { execFile, spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const repo = fileURLToPath(new URL('../../', import.meta.url));
export const failure = "Astrid couldn't finish. Your work is kept.";
export const preparation = 'Getting Astrid ready. The first time takes a few minutes.';
const mockUv = `#!/usr/bin/env python3
import json, os, pathlib, shutil, subprocess, sys, time
args = sys.argv[1:]
with open(os.environ['MOCK_CALLS'], 'a') as stream: stream.write(json.dumps(args) + '\\n')
print('native progress on stderr', file=sys.stderr)
if os.environ.get('MOCK_UNICODE_OUTPUT') and args[:1] == ['run']:
    sys.stdout.buffer.write('Workspace: 测试/Zoë\\n'.encode('utf-8'))
    sys.stdout.buffer.flush()
    sys.stderr.buffer.write('Diagnostic: 测试/Zoë\\n'.encode('utf-8'))
    sys.stderr.buffer.flush()
if args == ['--version']:
    print(os.environ.get('MOCK_UV_VERSION', 'uv 0.11.32 (x86_64-unknown-linux-gnu)'))
    sys.exit(0)
if args[:2] == ['python', 'install']:
    while os.environ.get('MOCK_PYTHON_RELEASE') and not pathlib.Path(os.environ['MOCK_PYTHON_RELEASE']).exists(): time.sleep(0.01)
    size = int(os.environ.get('MOCK_VOLUME_BYTES', '0'))
    if size:
        print('o' * size)
        print('e' * size, file=sys.stderr)
    sys.exit(int(os.environ.get('MOCK_PYTHON_EXIT', '0')))
if args[:1] == ['venv']:
    # Like uv 0.11: refuse to replace an existing environment without --clear.
    target = pathlib.Path(args[1])
    if target.exists() and '--clear' not in args:
        print('error: Failed to create virtual environment', file=sys.stderr)
        print(f'  Caused by: A virtual environment already exists at: {target}', file=sys.stderr)
        sys.exit(2)
    target.mkdir(parents=True, exist_ok=True)
    sys.exit(0)
if args[:2] == ['pip', 'install']:
    sys.exit(0)
if '-c' in args:
    start = args.index('-c')
    os.execv(sys.executable, [sys.executable, '-u', '-I', '-c', args[start + 1], *args[start + 2:]])
if os.environ.get('MOCK_REQUIRE_TTY'):
    assert sys.stdin.isatty(), 'uv must see terminal stdin to avoid duplicate SIGINT'
if os.environ.get('MOCK_CORE_APPEND_LOG'):
    with open(os.environ['MOCK_LOG'], 'a') as stream:
        if os.name == 'posix':
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stream.write('core opened its own log\\n')
        stream.flush()
        print('Core is writing its log.', flush=True)
        stream.write('core kept its own diagnostic\\n')
if os.environ.get('MOCK_STAGE_RELEASE'):
    # Emulate Python's stdout buffering according to the forwarded -u flag.
    sys.stdout.reconfigure(line_buffering='-u' in args)
    try:
        print('Installing Astrid.')
        while not pathlib.Path(os.environ['MOCK_STAGE_RELEASE']).exists(): time.sleep(0.01)
    except KeyboardInterrupt:
        pathlib.Path(os.environ['MOCK_INTERRUPTED']).write_text('KeyboardInterrupt reached installer')
        time.sleep(0.4)  # Cooperative rollback must finish before readers close.
        print(${JSON.stringify(failure)})
        print('Details: ' + os.environ['MOCK_LOG'])
        sys.exit(19)
if os.environ.get('MOCK_CORE_RAW_EXIT'):
    print('raw core diagnostic', file=sys.stderr)
    sys.exit(int(os.environ['MOCK_CORE_RAW_EXIT']))
if os.environ.get('MOCK_CORE_DISK_FAILURE'):
    print(${JSON.stringify(failure)})
    print('There is not enough free disk space to back up your workspace.')
    print('Details: ' + os.environ['MOCK_LOG'])
    sys.exit(1)
if os.environ.get('MOCK_REMOVE_BOOTSTRAP'):
    shutil.rmtree(pathlib.Path(os.environ.get('MOCK_UV_BOOTSTRAP', pathlib.Path(sys.argv[0]).parent)))
if os.environ.get('MOCK_CORE_EXIT'):
    print(${JSON.stringify(failure)})
    print('Details: ' + os.environ['MOCK_LOG'])
    sys.exit(int(os.environ['MOCK_CORE_EXIT']))
print('Astrid was uninstalled.' if '--uninstall' in args else 'Astrid is ready.')
`;

export async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'astrid-bootstrap-test-'));
  const home = path.join(root, 'home');
  // The POSIX installer's own layout (public/install): macOS is HOME-based and ignores XDG_*; Linux honours them.
  const macos = process.platform === 'darwin';
  const data = macos ? path.join(home, '.local/share') : path.join(root, 'data');
  const bootstrap = path.join(data, 'astrid/bootstrap');
  const installLog = macos ? path.join(home, 'Library/Logs/Astrid Runtime/install.log') : path.join(root, 'state/astrid-runtime/logs/install.log');
  const bin = path.join(root, 'bin');
  await Promise.all([mkdir(home, { recursive: true }), mkdir(bin), mkdir(bootstrap, { recursive: true })]);
  const manifest = JSON.parse(await readFile(path.join(repo, 'public/install-manifest.json'), 'utf8'));
  const manifestFile = path.join(root, 'source-manifest.json');
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    ASTRID_INSTALL_MANIFEST_URL: 'http://127.0.0.1:17427/developer-manifest.json',
    MOCK_MANIFEST: manifestFile,
    MOCK_CALLS: path.join(root, 'calls.jsonl'),
    MOCK_LOG: installLog,
  };
  for (const key of ['MOCK_PYTHON_EXIT', 'MOCK_CORE_EXIT', 'MOCK_REMOVE_BOOTSTRAP', 'MOCK_FETCH_EXIT', 'MOCK_VOLUME_BYTES', 'MOCK_UV_VERSION', 'MOCK_STAGE_RELEASE', 'MOCK_INTERRUPTED', 'MOCK_CORE_RAW_EXIT', 'MOCK_CORE_APPEND_LOG', 'MOCK_REQUIRE_TTY', 'MOCK_CORE_DISK_FAILURE', 'MOCK_UNICODE_OUTPUT', 'MOCK_ACL_FAILURE', 'MOCK_PYTHON_RELEASE']) delete env[key];
  await writeFile(path.join(bootstrap, 'uv'), mockUv, { mode: 0o755 });
  await writeFile(path.join(bin, 'curl'), `#!/usr/bin/env python3
import os, pathlib, shutil, sys
if os.environ.get('MOCK_FETCH_EXIT'): sys.exit(int(os.environ['MOCK_FETCH_EXIT']))
assert not sys.argv[5].endswith('runtime.lock'), 'bootstrap must not fetch the dependency lock'
if sys.argv[5].endswith('/developer-manifest.json') or sys.argv[5].endswith('/install-manifest.json'):
    pathlib.Path(os.environ['MOCK_FETCHED']).write_text(sys.argv[5])
shutil.copyfile(os.environ['MOCK_MANIFEST'], sys.argv[sys.argv.index('--output') + 1])
`, { mode: 0o755 });
  env.MOCK_FETCHED = path.join(root, 'fetched-url');
  return {
    root, home, bootstrap, manifest, env,
    async run(file, args, overrides = {}, timeout = 30_000) {
      await writeFile(manifestFile, JSON.stringify(manifest));
      try {
        const result = await execute(file, args, { cwd: repo, env: { ...env, ...overrides }, timeout });
        return { ...result, code: 0 };
      } catch (error) {
        if (typeof error.code !== 'number') throw error;
        return { stdout: error.stdout, stderr: error.stderr, code: error.code };
      }
    },
    async start(file, args, overrides = {}) {
      await writeFile(manifestFile, JSON.stringify(manifest));
      return spawn(file, args, { cwd: repo, env: { ...env, ...overrides }, timeout: 30_000 });
    },
    async calls() {
      try { return (await readFile(env.MOCK_CALLS, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
    async powershell() {
      env.LOCALAPPDATA = path.join(root, 'Windows Local Data');
      env.MOCK_LOG = path.join(env.LOCALAPPDATA, 'Astrid Runtime/logs/install.log');
      const windowsBootstrap = path.join(env.LOCALAPPDATA, 'Astrid Installer/bootstrap');
      env.MOCK_UV_BOOTSTRAP = windowsBootstrap;
      await mkdir(env.LOCALAPPDATA, { recursive: true });
      const systemPowerShellCommand = '$PowerShell = Join-Path $PSHOME $PowerShellName';
      if (process.platform === 'win32') {
        const mockScript = path.join(root, 'mock-uv.py');
        const launcherSource = path.join(root, 'mock-uv-launcher.cs');
        const launcherScript = path.join(root, 'build-mock-uv.ps1');
        const executable = path.join(root, 'mock-uv.exe');
        const systemPowerShellSource = path.join(root, 'mock-system-powershell.cs');
        const systemPowerShellScript = path.join(root, 'build-mock-system-powershell.ps1');
        const systemPowerShell = path.join(root, 'system root/System32/WindowsPowerShell/v1.0/powershell.exe');
        await writeFile(mockScript, mockUv);
        await writeFile(launcherSource, String.raw`
using System;
using System.Diagnostics;
using System.Text;
public static class AstridMockUvLauncher {
    private static string Quote(string value) {
        if (value.Length == 0) return "\"\"";
        if (value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
        var result = new StringBuilder();
        result.Append('"');
        int slashes = 0;
        foreach (char character in value) {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
                slashes = 0;
                continue;
            }
            result.Append('\\', slashes);
            slashes = 0;
            result.Append(character);
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }
    public static int Main(string[] arguments) {
        var info = new ProcessStartInfo();
        info.FileName = Environment.GetEnvironmentVariable("MOCK_UV_PYTHON");
        info.Arguments = Quote(Environment.GetEnvironmentVariable("MOCK_UV_SCRIPT")) +
            (arguments.Length == 0 ? "" : " " + String.Join(" ", Array.ConvertAll(arguments, Quote)));
        info.UseShellExecute = false;
        using (var process = Process.Start(info)) {
            process.WaitForExit();
            return process.ExitCode;
        }
    }
}
`);
        await writeFile(launcherScript, `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:MOCK_UV_LAUNCHER_SOURCE)) -OutputType ConsoleApplication -OutputAssembly $env:MOCK_UV_EXECUTABLE
`);
        await writeFile(systemPowerShellSource, String.raw`
using System;
using System.IO;
public static class AstridMockSystemPowerShell {
    public static int Main(string[] arguments) {
        string argumentPath = Environment.GetEnvironmentVariable("MOCK_BOOTSTRAP_ARGS");
        if (!String.IsNullOrEmpty(argumentPath)) File.WriteAllText(argumentPath, String.Join(Environment.NewLine, arguments));
        if (Environment.GetEnvironmentVariable("MOCK_BOOTSTRAP_STDERR") == "1") Console.Error.WriteLine("bootstrap progress on stderr");
        string source = Environment.GetEnvironmentVariable("MOCK_SOURCE_UV");
        if (String.IsNullOrEmpty(source)) source = Environment.GetEnvironmentVariable("MOCK_UV_SOURCE");
        string destination = Path.Combine(Environment.GetEnvironmentVariable("UV_UNMANAGED_INSTALL"), "uv.exe");
        File.Copy(source, destination, true);
        return 0;
    }
}
`);
        await writeFile(systemPowerShellScript, `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:MOCK_SYSTEM_POWERSHELL_SOURCE)) -OutputType ConsoleApplication -OutputAssembly $env:MOCK_SYSTEM_POWERSHELL_EXECUTABLE
`);
        env.MOCK_UV_SCRIPT = mockScript;
        env.MOCK_UV_PYTHON = process.env.ASTRID_TEST_PYTHON || 'python';
        env.MOCK_UV_LAUNCHER_SOURCE = launcherSource;
        env.MOCK_UV_EXECUTABLE = executable;
        env.MOCK_SYSTEM_POWERSHELL_SOURCE = systemPowerShellSource;
        env.MOCK_SYSTEM_POWERSHELL_EXECUTABLE = systemPowerShell;
        await mkdir(path.dirname(systemPowerShell), { recursive: true });
        await rm(executable, { force: true });
        await rm(systemPowerShell, { force: true });
        await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcherScript], { cwd: repo, env });
        await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', systemPowerShellScript], { cwd: repo, env });
        env.MOCK_UV_SOURCE = executable;
        const windowsInstaller = path.join(root, 'windows-install.ps1');
        const installerScript = (await readFile(path.join(repo, 'public/install.ps1'), 'utf8'))
          .replace(systemPowerShellCommand, `$PowerShell = '${systemPowerShell}'`);
        await writeFile(windowsInstaller, installerScript);
        env.MOCK_INSTALL_SCRIPT = windowsInstaller;
      } else {
        env.MOCK_UV_SOURCE = path.join(root, 'mock-uv-source.exe');
        await mkdir(windowsBootstrap, { recursive: true });
        await cp(path.join(bootstrap, 'uv'), env.MOCK_UV_SOURCE);
        await chmod(env.MOCK_UV_SOURCE, 0o755);
        const posixInstaller = path.join(root, 'posix-test-install.ps1');
        const installerScript = (await readFile(path.join(repo, 'public/install.ps1'), 'utf8'))
          .replace(systemPowerShellCommand, '$PowerShell = (Get-Process -Id $PID).Path');
        await writeFile(posixInstaller, installerScript);
        env.MOCK_INSTALL_SCRIPT = posixInstaller;
      }
      const harness = path.join(root, 'invoke.ps1');
      await writeFile(harness, `
$ErrorActionPreference = 'Continue'
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, [Parameter(Position=0)][string]$Uri, [string]$OutFile)
    if ($env:MOCK_FETCH_EXIT) { throw 'The fixture download failed.' }
    if ($Uri.StartsWith('https://astral.sh/')) {
        [IO.File]::WriteAllText($OutFile, @'
Copy-Item -LiteralPath $env:MOCK_UV_SOURCE -Destination (Join-Path $env:UV_UNMANAGED_INSTALL 'uv.exe') -Force
'@)
    } else {
        if ($Uri.EndsWith('/developer-manifest.json') -or $Uri.EndsWith('/install-manifest.json')) { [IO.File]::WriteAllText($env:MOCK_FETCHED, $Uri) }
        Copy-Item $env:MOCK_MANIFEST $OutFile
    }
}
if ($env:MOCK_PROCESSOR_ARCHITECTURE) { $env:PROCESSOR_ARCHITECTURE = $env:MOCK_PROCESSOR_ARCHITECTURE }
$InstallerArgs = @()
if ($env:MOCK_INSTALLER_ARGS) {
    foreach ($EncodedArgument in ($env:MOCK_INSTALLER_ARGS -split ',')) {
        $InstallerArgs += [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedArgument.Substring(1)))
    }
}
try {
    if ($InstallerArgs.Count) {
        & ([scriptblock]::Create([IO.File]::ReadAllText($env:MOCK_INSTALL_SCRIPT))) @InstallerArgs
    } else {
        Invoke-Expression ([IO.File]::ReadAllText($env:MOCK_INSTALL_SCRIPT))
    }
} catch {
    [Console]::WriteLine('CAUGHT: ' + $_.Exception.Message)
    if (Test-Path -LiteralPath $env:MOCK_LOG) { [Console]::WriteLine('INSTALL-LOG: ' + [IO.File]::ReadAllText($env:MOCK_LOG)) }
}
[Console]::WriteLine('SHELL-ALIVE')
[Console]::WriteLine('PREFERENCE: ' + $ErrorActionPreference)
[Console]::WriteLine('NATIVE-STATUS: ' + $global:LASTEXITCODE)
`);
      return harness;
    },
    cleanup() { return rm(root, { recursive: true, force: true }); },
  };
}

export function observe(child) {
  let stdout = '';
  let stderr = '';
  const waiting = [];
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (const item of waiting) if (stdout.includes(item.marker)) item.resolve();
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      for (const item of waiting) if (!stdout.includes(item.marker)) item.reject(new Error(`Exited before ${item.marker}: ${stderr}`));
      resolve({ stdout, stderr, code, signal });
    });
  });
  return {
    result,
    until(marker) {
      if (stdout.includes(marker)) return Promise.resolve();
      return new Promise((resolve, reject) => waiting.push({ marker, resolve, reject }));
    },
  };
}

export async function createPinnedRepo(repoPath, sourceContent) {
  await mkdir(repoPath, { recursive: true });
  await writeFile(path.join(repoPath, 'source-marker.txt'), sourceContent);
  await execute('git', ['init', '--quiet'], { cwd: repoPath });
  await execute('git', ['config', 'user.name', 'Astrid bootstrap test'], { cwd: repoPath });
  await execute('git', ['config', 'user.email', 'bootstrap-test@example.invalid'], { cwd: repoPath });
  await execute('git', ['add', 'source-marker.txt'], { cwd: repoPath });
  await execute('git', ['commit', '--quiet', '-m', 'pin source fixture'], { cwd: repoPath });
  return (await execute('git', ['rev-parse', 'HEAD'], { cwd: repoPath })).stdout.trim();
}

// pty.fork supplies a real controlling terminal. Writing ^C exercises the
// terminal's foreground process-group delivery instead of killing one PID.
export const terminalInterrupt = `
import errno, json, os, pty, select, signal, sys, time
pid, terminal = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
output = bytearray()
interrupted = False
startup_deadline = time.monotonic() + 90
recovery_deadline = None
try:
    while True:
        now = time.monotonic()
        deadline = recovery_deadline if interrupted else startup_deadline
        if now >= deadline:
            if interrupted:
                raise TimeoutError('installer did not recover within 20 seconds after terminal Ctrl+C: ' + output.decode(errors='replace'))
            raise TimeoutError('installer did not reach its streamed stage within 90 seconds: ' + output.decode(errors='replace'))
        readable, _, _ = select.select([terminal], [], [], min(0.05, deadline - now))
        if readable:
            try: chunk = os.read(terminal, 65536)
            except OSError as error:
                if error.errno != errno.EIO: raise
                break
            if not chunk: break
            output.extend(chunk)
            if not interrupted and b'Installing Astrid.' in output:
                os.write(terminal, b'\\x03')
                interrupted = True
                recovery_deadline = time.monotonic() + 20
        finished, status = os.waitpid(pid, os.WNOHANG)
        if finished:
            pid = None
            break
    if pid is not None:
        _, status = os.waitpid(pid, 0)
        pid = None
    print(json.dumps(dict(output=output.decode(errors='replace'), code=os.waitstatus_to_exitcode(status), interrupted=interrupted)))
finally:
    if pid is not None:
        os.killpg(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os.close(terminal)
`;
