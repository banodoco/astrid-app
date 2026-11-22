// Process accounting reads only identity, parent and CPU counters, never arguments or environment.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';

export function parseStat(raw) {
  const end = raw.lastIndexOf(')');
  const pid = Number(raw.slice(0, raw.indexOf(' ')));
  const f = raw.slice(end + 1).trim().split(/\s+/);
  if (end < 0 || f.length < 20 || !Number.isSafeInteger(pid) || ![f[1], f[11], f[12], f[19]].every(x => /^\d+$/.test(x))) throw new Error('invalid proc stat');
  return {pid, ppid:Number(f[1]), cpu:Number(f[11]) + Number(f[12]), start:f[19]};
}
export function parsePsTime(value) {
  const match=/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) throw new Error('invalid ps CPU time');
  return Number(match[1]||0)*86400 + Number(match[2]||0)*3600 + Number(match[3])*60 + Number(match[4]);
}
export function parsePs(raw) {
  const all=new Map();
  for (const line of raw.trim().split('\n')) {
    if (!line.trim()) continue;
    const m=/^\s*(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s*$/.exec(line);
    if (!m) throw new Error('invalid ps process record');
    const pid=Number(m[1]);
    // Darwin Runtime formats a one-digit day with two spaces before it.
    const parts=m[4].split(/\s+/);
    const start=`ps-lstart:${parts[0]} ${parts[1]} ${parts[2].padStart(2,' ')} ${parts[3]} ${parts[4]}`;
    all.set(pid,{pid,ppid:Number(m[2]),cpu:parsePsTime(m[3]),start});
  }
  return all;
}
function linuxStat(pid) { return parseStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); }
function linuxSnapshot() {
  const all=new Map();
  for (const name of fs.readdirSync('/proc')) if (/^\d+$/.test(name)) {
    try { const s=linuxStat(name); all.set(s.pid,s); } catch { /* a process can exit during the scan */ }
  }
  return all;
}
function psSnapshot() {
  return parsePs(execFileSync('ps',['-axo','pid=,ppid=,time=,lstart='],{encoding:'utf8',env:{LC_ALL:'C',PATH:'/usr/bin:/bin'}}));
}
function snapshot(platform) {
  if (platform === 'linux') return linuxSnapshot();
  if (platform === 'darwin') return psSnapshot();
  throw new Error('CPU accounting requires Linux or macOS');
}
export function processRoot(pid, platform=process.platform) {
  const first=snapshot(platform).get(pid), second=snapshot(platform).get(pid);
  if (!first || !second || first.start !== second.start) throw new Error('process identity unavailable or changed');
  return {pid,start:first.start};
}
export function runtimeRoot(root, platform=process.platform) {
  const ready = JSON.parse(fs.readFileSync(path.join(root,'data/runtime/discovery.json'),'utf8'));
  const sandbox = JSON.parse(fs.readFileSync(path.join(root,'sandbox.json'),'utf8'));
  const {pid, process_birth_id:birth, runtime_instance_id:instance} = ready;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !instance || instance !== sandbox.runtimeHealth?.runtimeInstanceId || typeof birth !== 'string') throw new Error('Runtime discovery identity does not match owned sandbox');
  const observed=processRoot(pid,platform);
  let expected=observed.start;
  if (platform === 'linux') {
    expected = `proc-start-ticks:${observed.start}`;
    try { expected += `;boot:${fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()}`; } catch {}
    try { expected += `;pidns:${fs.statSync(`/proc/${pid}/ns/pid`).ino}`; } catch {}
  }
  if (birth !== expected) throw new Error('Runtime discovery process identity changed or is unavailable');
  return observed;
}
export function createCpuSampler(runtime, browser, cadence = 250, options = {}) {
  const platform=options.platform ?? process.platform;
  const read=options.readSnapshot ?? (()=>snapshot(platform));
  const hz=platform === 'linux' ? Number(options.hz ?? execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}).trim()) : 1;
  if (!['linux','darwin'].includes(platform) || !Number.isFinite(hz) || hz <= 0) throw new Error('CPU accounting resolution unavailable');
  const roots = {runtime, browser};
  const totals = {runtime:0, browser:0};
  let seen = {runtime:new Map(), browser:new Map()};
  const history = {runtime:new Map(), browser:new Map()};
  let first = true, gaps = 0, failure;
  function sample() {
    const all=read();
    for (const [label, root] of Object.entries(roots)) if (all.get(root.pid)?.start !== root.start) throw new Error(`${label} process identity lost`);
    const members = {runtime:new Set([runtime.pid]),browser:new Set([browser.pid])};
    let changed = true;
    while (changed) { changed=false; for (const s of all.values()) if (members.browser.has(s.ppid) && !members.browser.has(s.pid)) { members.browser.add(s.pid); changed=true; } }
    if (members.browser.has(runtime.pid)) throw new Error('Runtime and browser process sets overlap');
    for (const label of ['runtime','browser']) {
      const now = new Map();
      for (const pid of members[label]) {
        const s=all.get(pid); if (!s) { gaps++; continue; }
        const key=`${s.pid}:${s.start}`; now.set(key,s.cpu);
        const old=seen[label].get(key);
        if (old !== undefined) {
          if (s.cpu < old) { gaps++; continue; }
          totals[label] += s.cpu-old;
        } else if (history[label].has(key)) { gaps++; totals[label] += Math.max(0,s.cpu-history[label].get(key)); }
        else if (!first) totals[label] += s.cpu;
        history[label].set(key,s.cpu);
      }
      for (const key of seen[label].keys()) if (!now.has(key)) gaps++;
      seen[label]=now;
    }
    first=false;
  }
  sample();
  const timer=setInterval(()=>{ try {sample();} catch (e) {failure=e;} },cadence); timer.unref();
  function mark() {
    if (!failure) try {sample();} catch (error) {failure=error;}
    return {at:performance.now(), wall:new Date().toISOString(), totals:{...totals}, gaps, failure:failure ? String(failure.message) : null};
  }
  function delta(start, label) {
    const end=mark(), newGaps=end.gaps-start.gaps, error=start.failure || end.failure, qualified=newGaps===0 && !error;
    return {label, start_at:start.wall, end_at:end.wall, wall_ms:end.at-start.at,
      runtime_cpu_seconds:qualified ? (end.totals.runtime-start.totals.runtime)/hz : null,
      browser_cpu_seconds:qualified ? (end.totals.browser-start.totals.browser)/hz : null,
      qualified, unqualified_reason:qualified ? null : (error || 'observed process identity gap or exit'), runtime, browser,
      cadence_ms:cadence, counter:platform==='linux' ? 'proc_stat_ticks' : 'ps_cpu_time',
      resolution_seconds:platform==='linux' ? 1/hz : 1,
      observed_process_exits_or_gaps:newGaps};
  }
  return {mark,delta,close:()=>clearInterval(timer)};
}
