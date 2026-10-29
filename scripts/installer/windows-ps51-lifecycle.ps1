# Native, disposable-machine lifecycle leg. Run with Windows PowerShell 5.1.
# The sole fixture mutation is the old chat service argv before --update.
param(
    [Parameter(Mandatory=$true)][string]$RunRoot,
    [Parameter(Mandatory=$true)][string]$Verifier,
    [Parameter(Mandatory=$true)][string]$ProductApp,
    [Parameter(Mandatory=$true)][string]$FrozenManifest,
    [switch]$SafetyOnly
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or $env:OS -ne 'Windows_NT') { throw 'This leg requires native Windows PowerShell 5.1.' }
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:ImageOS -ne 'win22') { throw 'This leg requires a GitHub-hosted windows-2022 disposable VM.' }
if ($env:ASTRID_INSTALL_MANIFEST_URL) { throw 'Unexpected manifest override.' }
# Require a local, previously nonexistent run root. Reject dot segments, 8.3
# names, reparse points and substituted drives instead of following aliases.
if ($RunRoot -notmatch '^[A-Za-z]:\\' -or $RunRoot -match '(^|\\)\.{1,2}($|\\)' -or $RunRoot -match '~[0-9]' -or $RunRoot -match '(^|\\)[^\\]*[ .]($|\\)') { throw 'RunRoot must be an unaliased local absolute path.' }
$RunRoot = [IO.Path]::GetFullPath($RunRoot).TrimEnd('\')
$Drive = $RunRoot.Substring(0, 2)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TstB3Path {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern uint QueryDosDevice(string device, StringBuilder target, int length);
}
'@
$Target = New-Object Text.StringBuilder 32768
if ([TstB3Path]::QueryDosDevice($Drive, $Target, $Target.Capacity) -eq 0 -or $Target.ToString().StartsWith('\??\', [StringComparison]::OrdinalIgnoreCase)) { throw 'RunRoot drive is missing or substituted.' }
if (Test-Path -LiteralPath $RunRoot) { throw 'RunRoot must not already exist.' }
$Ancestor = Split-Path -Parent $RunRoot
while ($Ancestor) {
    if (Test-Path -LiteralPath $Ancestor) {
        $Item = Get-Item -Force -LiteralPath $Ancestor
        if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not ($Item.Attributes -band [IO.FileAttributes]::Directory)) { throw "Unsafe RunRoot ancestor: $Ancestor" }
    }
    $Parent = Split-Path -Parent $Ancestor
    if (-not $Parent -or $Parent -eq $Ancestor) { break }
    $Ancestor = $Parent
}
if (Get-ScheduledTask | Where-Object { $_.TaskName -eq 'Astrid Runtime' -and $_.TaskPath -eq '\' }) { throw 'Use a disposable account without an existing Astrid Runtime task.' }
$OriginalLocal = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if (-not $OriginalLocal -or -not [IO.Path]::IsPathRooted($OriginalLocal) -or -not [IO.Path]::GetFullPath($OriginalLocal).Equals([IO.Path]::GetFullPath($env:LOCALAPPDATA), [StringComparison]::OrdinalIgnoreCase)) { throw 'LOCALAPPDATA must identify the actual account location.' }
$Protected = @('Astrid', 'Astrid Installer', 'Astrid Runtime', 'astrid-install.json') | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $OriginalLocal $_)).TrimEnd('\') }
foreach ($Path in $Protected) {
    if ($RunRoot.Equals($Path, [StringComparison]::OrdinalIgnoreCase) -or $RunRoot.StartsWith($Path + '\', [StringComparison]::OrdinalIgnoreCase) -or $Path.StartsWith($RunRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'RunRoot overlaps a default Astrid path.' }
}
function Assert-DefaultPathsUntouched {
    foreach ($Path in $Protected) { if (Test-Path -LiteralPath $Path) { throw "Default Astrid path exists or changed: $Path" } }
}
Assert-DefaultPathsUntouched
if (-not [IO.Path]::IsPathRooted($Verifier) -or -not (Test-Path -LiteralPath $Verifier -PathType Leaf)) { throw 'Verifier must be the absolute path to B1/V1 scripts/verify_installed.py.' }
$ProgramRoot = Join-Path $RunRoot 'program'
$DataRoot = Join-Path $RunRoot 'data'
$ReceiptDir = Join-Path $RunRoot 'receipts'
$OwnedLocal = Join-Path $RunRoot 'local-appdata'
$OwnedTemp = Join-Path $RunRoot 'temp'
$OwnedCache = Join-Path $RunRoot 'uv-cache'
# These are fixed, distinct children of the admitted run root.
foreach ($Path in @($ProgramRoot, $DataRoot, $ReceiptDir, $OwnedLocal, $OwnedTemp, $OwnedCache)) {
    if (-not ([IO.Path]::GetFullPath($Path).StartsWith($RunRoot + '\', [StringComparison]::OrdinalIgnoreCase))) { throw 'Path escaped RunRoot.' }
}
if ($SafetyOnly) { Write-Output 'Safety preflight passed; no paths created and no installer invoked.'; return }
New-Item -ItemType Directory -Path $ReceiptDir, $OwnedLocal, $OwnedTemp, $OwnedCache -Force | Out-Null
$env:LOCALAPPDATA = $OwnedLocal
$env:TEMP = $OwnedTemp
$env:TMP = $OwnedTemp
$env:UV_CACHE_DIR = $OwnedCache
$env:ASTRID_RUNTIME_DATA_ROOT = $DataRoot
if ($env:ASTRID_PACKS_PATH) { throw 'Remove ASTRID_PACKS_PATH before running the isolated journey.' }
$Installer = Join-Path $ProductApp 'public/install.ps1'
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf) -or -not (Test-Path -LiteralPath $FrozenManifest -PathType Leaf)) { throw 'Frozen product inputs are missing.' }
$Shell = Join-Path $PSHOME 'powershell.exe'
$Served = Get-Content -Raw -Encoding UTF8 -LiteralPath $FrozenManifest | ConvertFrom-Json
if ($Served.agent.sha -cne '3204bb00135bec8ee2d2d3fb21eed5abfceca649' -or $Served.runtime.sha -cne '6d53a19070faf63fc15ae1f81417722edc2c8a5f') { throw 'Frozen manifest product pins differ from the reviewed tuple.' }
if ($Served.agent.PSObject.Properties['repo'] -or $Served.runtime.PSObject.Properties['repo']) { throw 'Production manifest unexpectedly contains a source override.' }
function Invoke-Install([string[]]$Extra) {
    Assert-OwnedPath $ProgramRoot
    Assert-OwnedPath $DataRoot
    Assert-OwnedPath $OwnedLocal
    Assert-OwnedPath $OwnedTemp
    Assert-OwnedPath $OwnedCache
    $Links = @(Get-ChildItem -Force -Recurse -LiteralPath $RunRoot | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
    if ($Links.Count) { throw 'RunRoot contains a reparse point; refusing installer cleanup.' }
    try {
        & $Shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Installer @Extra --manifest $FrozenManifest --root $ProgramRoot --data-root $DataRoot
        $Code = $LASTEXITCODE
    } finally { Assert-DefaultPathsUntouched }
    if ($Code -ne 0) { throw "Installer failed with exit code $Code." }
}
function Assert-OwnedPath([string]$Path) {
    $Full = [IO.Path]::GetFullPath($Path)
    if (-not $Full.StartsWith($RunRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Path escaped RunRoot: $Path" }
    $Part = $Full
    while ($Part.Length -ge $RunRoot.Length) {
        if (Test-Path -LiteralPath $Part) {
            if ((Get-Item -Force -LiteralPath $Part).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Run-owned path contains a reparse point: $Part" }
        }
        if ($Part -eq $RunRoot) { break }
        $Part = Split-Path -Parent $Part
    }
}
function Get-Installed {
    $Name = (Get-Content -Raw -LiteralPath (Join-Path $ProgramRoot 'current')).Trim()
    if ($Name -notmatch '^[A-Za-z0-9_-]+$') { throw 'Invalid current version.' }
    $Folder = Join-Path (Join-Path $ProgramRoot 'versions') $Name
    $Profile = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $Folder 'profile.json') | ConvertFrom-Json
    $Manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $Folder 'manifest.json') | ConvertFrom-Json
    if ($Manifest.agent.sha -cne $Served.agent.sha -or $Manifest.runtime.sha -cne $Served.runtime.sha -or $Manifest.agent.PSObject.Properties['repo'] -or $Manifest.runtime.PSObject.Properties['repo']) { throw 'Installed pins do not match the production manifest snapshot.' }
    Assert-OwnedPath $Folder
    Assert-OwnedPath $Profile.service_declaration
    if (-not (Test-Path -LiteralPath $Profile.service_declaration)) { throw 'Missing service declaration.' }
    return @{ Name = $Name; Folder = $Folder; Profile = $Profile; VersionPath = (Join-Path $Folder 'version.json') }
}
function Assert-Running($Version) {
    $Task = @(Get-ScheduledTask | Where-Object { $_.TaskName -eq 'Astrid Runtime' -and $_.TaskPath -eq '\' })
    if ($Task.Count -ne 1 -or $Task[0].State -ne 'Running') { throw 'Astrid Runtime task is absent or not running.' }
    $Action = @($Task[0].Actions)
    if ($Action.Count -ne 1 -or $Action[0].Execute.IndexOf($Version.Folder, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or $Action[0].Arguments.IndexOf($Version.Name, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'Scheduled task does not point to the current version.' }
    $Discovery = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $DataRoot 'runtime/discovery.json') | ConvertFrom-Json
    $Door = [Uri]$Discovery.door_endpoint
    if ($Door.Scheme -ne 'http' -or $Door.Host -ne '127.0.0.1' -or $Door.AbsolutePath -ne '/') { throw 'Discovery does not identify a loopback Runtime door.' }
    $Headers = @{ Origin = 'https://astrid.haus' }
    $Health = Invoke-RestMethod -Uri ($Discovery.door_endpoint.TrimEnd('/') + '/api/runtime/v1/health') -Headers $Headers
    $Realm = Invoke-RestMethod -Uri ($Discovery.door_endpoint.TrimEnd('/') + '/api/runtime/v1/realm') -Headers $Headers
    if ($Health.status -ne 'ok' -or $Health.runtime_instance_id -ne $Discovery.runtime_instance_id -or $Realm.realm_id -ne $Discovery.active_realm) { throw 'Runtime health, identity, or realm does not match discovery.' }
}
function Invoke-Verifier($Version, [string]$Mode, [string]$Output, [string]$Before = '') {
    $Record = Get-Content -Raw -Encoding UTF8 -LiteralPath $Version.VersionPath | ConvertFrom-Json
    Assert-OwnedPath $Record.python
    Assert-OwnedPath $Output
    $Arguments = @($Verifier, '--mode', $Mode, '--version', $Version.VersionPath, '--data-root', $DataRoot, '--output', $Output)
    if ($Before) { $Arguments += @('--before', $Before) }
    & $Record.python @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Installed-product verifier failed ($Mode); see $Output." }
}
# A separate process is our unrelated sentinel; PID and creation time prevent PID reuse.
$SentinelProcess = Start-Process -FilePath $Shell -ArgumentList '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 10800' -PassThru
$SentinelBirth = (Get-Process -Id $SentinelProcess.Id).StartTime.ToUniversalTime().Ticks
function Assert-Sentinel {
    $Process = Get-Process -Id $SentinelProcess.Id -ErrorAction SilentlyContinue
    if (-not $Process -or $Process.StartTime.ToUniversalTime().Ticks -ne $SentinelBirth) { throw 'Unrelated sentinel did not survive.' }
}
$Result = @{ fresh = 'not-run'; stale_update = 'not-run'; reinstall = 'not-run'; cleanup = 'not-run'; sentinel_pid = $SentinelProcess.Id; sentinel_birth_ticks = $SentinelBirth }
$Failure = $null
try {
Assert-Sentinel
$Result.fresh = 'running'
Invoke-Install @()
$Fresh = Get-Installed
Assert-Running $Fresh
$BeforeReceipt = Join-Path $ReceiptDir 'fresh.json'
Invoke-Verifier $Fresh 'install' $BeforeReceipt
$Result.fresh = 'pass'
Assert-Sentinel
$Sentinel = Join-Path $DataRoot 'tst-b3-user-data.txt'
Assert-OwnedPath $Sentinel
$Payload = 'TST B3 user data ' + [Guid]::NewGuid().ToString('N')
[IO.File]::WriteAllText($Sentinel, $Payload, [Text.UTF8Encoding]::new($false))
$DeclarationPath = $Fresh.Profile.service_declaration
$Declaration = Get-Content -Raw -Encoding UTF8 -LiteralPath $DeclarationPath | ConvertFrom-Json
$Chat = @($Declaration.services | Where-Object { $_.name -eq 'chat' })
if ($Chat.Count -ne 1 -or $Chat[0].argv.Count -lt 2) { throw 'Expected one chat declaration with argv.' }
$StaleMarker = 'TST-B3-stale-chat-command'
$Chat[0].argv[1] = $StaleMarker
[IO.File]::WriteAllText($DeclarationPath, ($Declaration | ConvertTo-Json -Depth 50), [Text.UTF8Encoding]::new($false))
$Result.stale_update = 'running'
Invoke-Install @('--update')
$Updated = Get-Installed
if ($Updated.Name -eq $Fresh.Name) { throw 'Update did not switch versions.' }
$UpdatedDeclarationText = Get-Content -Raw -Encoding UTF8 -LiteralPath $Updated.Profile.service_declaration
if ($UpdatedDeclarationText.Contains($StaleMarker)) { throw 'Update retained the stale chat declaration.' }
$UpdatedChat = @(($UpdatedDeclarationText | ConvertFrom-Json).services | Where-Object { $_.name -eq 'chat' })
if ($UpdatedChat.Count -ne 1 -or $UpdatedChat[0].argv.Count -lt 2 -or $UpdatedChat[0].argv[1].IndexOf($Updated.Folder, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'Updated chat declaration does not point to the candidate.' }
Assert-Running $Updated
Invoke-Verifier $Updated 'update' (Join-Path $ReceiptDir 'update.json') $BeforeReceipt
if ([IO.File]::ReadAllText($Sentinel) -cne $Payload) { throw 'Update changed user data.' }
$Result.stale_update = 'pass'
Assert-Sentinel
$Result.reinstall = 'running'
# Match the product reinstall contract: uninstall the owned installation first,
# then run the frozen installer again while keeping the selected data root.
$PreReinstall = Get-Installed
$PreReinstallRecord = Get-Content -Raw -Encoding UTF8 -LiteralPath $PreReinstall.VersionPath | ConvertFrom-Json
Assert-OwnedPath $PreReinstallRecord.python
foreach ($Property in $PreReinstallRecord.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($Property.Name, [string]$Property.Value, 'Process') }
& $PreReinstallRecord.python -I -m astrid install --uninstall --root $ProgramRoot --data-root $DataRoot
if ($LASTEXITCODE -ne 0) { throw "Owned reinstall pre-uninstall failed: $LASTEXITCODE" }
if (Test-Path -LiteralPath (Join-Path $ProgramRoot 'current')) { throw 'Pre-reinstall uninstall retained current.' }
if (Get-ScheduledTask | Where-Object { $_.TaskName -eq 'Astrid Runtime' -and $_.TaskPath -eq '\' }) { throw 'Pre-reinstall uninstall retained the scheduled task.' }
if ([IO.File]::ReadAllText($Sentinel) -cne $Payload) { throw 'Pre-reinstall uninstall changed user data.' }
Invoke-Install @()
$Reinstalled = Get-Installed
Assert-Running $Reinstalled
Invoke-Verifier $Reinstalled 'install' (Join-Path $ReceiptDir 'reinstall.json')
if ([IO.File]::ReadAllText($Sentinel) -cne $Payload) { throw 'Reinstall changed user data.' }
$Result.reinstall = 'pass'
Assert-Sentinel
Assert-DefaultPathsUntouched
} catch {
    $Failure = $_.Exception.Message
    foreach ($Leg in @('fresh', 'stale_update', 'reinstall')) { if ($Result[$Leg] -eq 'running') { $Result[$Leg] = 'fail' } }
    $Result.error = $Failure
} finally {
    try {
        Assert-Sentinel
        Assert-OwnedPath $ProgramRoot
        Assert-OwnedPath $DataRoot
        $Tasks = @(Get-ScheduledTask | Where-Object { $_.TaskName -eq 'Astrid Runtime' -and $_.TaskPath -eq '\' })
        if ($Tasks.Count -gt 1) { throw 'Unexpected duplicate scheduled tasks.' }
        if ($Tasks.Count -eq 1) {
            $Actions = @($Tasks[0].Actions)
            $Prefix = $ProgramRoot.TrimEnd('\') + '\'
            if ($Actions.Count -ne 1 -or -not ([IO.Path]::GetFullPath($Actions[0].Execute).StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase))) { throw 'Refusing cleanup of task outside owned root.' }
        }
        if (Test-Path -LiteralPath (Join-Path $ProgramRoot 'current') -PathType Leaf) {
            $Installed = Get-Installed
            $Record = Get-Content -Raw -Encoding UTF8 -LiteralPath $Installed.VersionPath | ConvertFrom-Json
            Assert-OwnedPath $Record.python
            if ([IO.Path]::GetFullPath([string]$Record.root) -cne [IO.Path]::GetFullPath([string]$Installed.Folder)) { throw 'Version root does not match the owned current version.' }
            $Marker = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $ProgramRoot 'install.json') | ConvertFrom-Json
            if ([IO.Path]::GetFullPath([string]$Marker.data_root) -cne [IO.Path]::GetFullPath($DataRoot)) { throw 'Install marker data root is not owned.' }
            foreach ($Property in $Record.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($Property.Name, [string]$Property.Value, 'Process') }
            & $Record.python -I -m astrid install --uninstall --root $ProgramRoot --data-root $DataRoot
            if ($LASTEXITCODE -ne 0) { throw "Owned uninstall failed: $LASTEXITCODE" }
        }
        if (Get-ScheduledTask | Where-Object { $_.TaskName -eq 'Astrid Runtime' -and $_.TaskPath -eq '\' }) { throw 'Scheduled task remains after cleanup.' }
        if (Test-Path -LiteralPath (Join-Path $ProgramRoot 'current')) { throw 'Current installation remains after cleanup.' }
        $ParentPid = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
        $OwnedProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.ProcessId -ne $ParentPid -and $_.ProcessId -ne $SentinelProcess.Id -and (($_.ExecutablePath -and $_.ExecutablePath.StartsWith($ProgramRoot + '\', [StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and ($_.CommandLine.Contains($ProgramRoot) -or $_.CommandLine.Contains($DataRoot)))) })
        if ($OwnedProcesses.Count) { throw 'Processes referencing the owned installation remain after cleanup.' }
        Assert-Sentinel
        $Result.cleanup = 'pass'
    } catch {
        $Result.cleanup = 'fail'
        $Result.cleanup_error = $_.Exception.Message
        if (-not $Failure) { $Failure = $Result.cleanup_error }
    } finally {
        $Result | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $ReceiptDir 'b3-result.json')
        $Observed = Get-Process -Id $SentinelProcess.Id -ErrorAction SilentlyContinue
        if ($Observed -and $Observed.StartTime.ToUniversalTime().Ticks -eq $SentinelBirth) { Stop-Process -Id $SentinelProcess.Id }
    }
}
if ($Failure) { throw $Failure }
Write-Output 'B3 lifecycle and owned cleanup passed.'
