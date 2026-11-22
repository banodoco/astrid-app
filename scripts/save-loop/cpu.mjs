// Linux /proc accounting. Never inspect process arguments or environment.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';

export function parseStat(raw) {
  const end = raw.lastIndexOf(')');
  const pid = Number(raw.slice(0, raw.indexOf(' ')));
  const f = raw.slice(end + 1).trim().split(/\s+/);
  if (end < 0 || f.length < 20 || !Number.isSafeInteger(pid) || ![f[1], f[11], f[12], f[19]].every(x => /^\d+$/.test(x))) throw new Error('invalid proc stat');
  return {pid, ppid:Number(f[1]), ticks:Number(f[11]) + Number(f[12]), start:f[19]};
}
function stat(pid) { return parseStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); }
export function runtimeRoot(root) {
  const ready = JSON.parse(fs.readFileSync(path.join(root,'data/runtime/discovery.json'),'utf8'));
  const sandbox = JSON.parse(fs.readFileSync(path.join(root,'sandbox.json'),'utf8'));
  const {pid, process_birth_id:birth, runtime_instance_id:instance} = ready;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !instance || instance !== sandbox.runtimeHealth?.runtimeInstanceId || typeof birth !== 'string') throw new Error('Runtime discovery identity does not match owned sandbox');
  const s = stat(pid);
  let expected = `proc-start-ticks:${s.start}`;
  try { expected += `;boot:${fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()}`; } catch {}
  try { expected += `;pidns:${fs.statSync(`/proc/${pid}/ns/pid`).ino}`; } catch {}
  if (birth !== expected || stat(pid).start !== s.start) throw new Error('Runtime discovery process identity changed or is unavailable');
  return {pid, start:s.start};
}
export function createCpuSampler(runtime, browser, cadence = 250) {
  if (process.platform !== 'linux') throw new Error('CPU accounting requires Linux /proc');
  const hz = Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}).trim());
  if (!Number.isFinite(hz) || hz <= 0) throw new Error('CLK_TCK unavailable');
  const roots = {runtime, browser};
  const totals = {runtime:0, browser:0};
  const seen = {runtime:new Map(), browser:new Map()};
  let first = true, gaps = 0, failure;
  function sample() {
    const all = new Map();
    for (const name of fs.readdirSync('/proc')) if (/^\d+$/.test(name)) {
      try { const s=stat(name); all.set(s.pid,s); } catch { /* process may exit during scan */ }
    }
    for (const [label, root] of Object.entries(roots)) {
      if (all.get(root.pid)?.start !== root.start) throw new Error(`${label} process identity lost`);
    }
    const members = {runtime:new Set([runtime.pid]),browser:new Set([browser.pid])};
    let changed = true;
    while (changed) { changed=false; for (const s of all.values()) for (const label of ['browser']) if (members[label].has(s.ppid) && !members[label].has(s.pid)) { members[label].add(s.pid); changed=true; } }
    if (members.browser.has(runtime.pid) || members.runtime.has(browser.pid)) throw new Error('Runtime and browser process sets overlap');
    for (const label of ['runtime','browser']) {
      const now = new Map();
      for (const pid of members[label]) {
        const s=all.get(pid); if (!s) { gaps++; continue; }
        const key=`${s.pid}:${s.start}`; now.set(key,s.ticks);
        const old=seen[label].get(key);
        if (old !== undefined) totals[label] += Math.max(0,s.ticks-old);
        else if (!first) totals[label] += s.ticks;
      }
      for (const key of seen[label].keys()) if (!now.has(key)) gaps++;
      seen[label]=now;
    }
    first=false;
  }
  sample();
  const timer=setInterval(()=>{ try {sample();} catch (e) {failure=e;} },cadence); timer.unref();
  function mark() { if (failure) throw failure; sample(); return {at:performance.now(), wall:new Date().toISOString(), totals:{...totals}, gaps}; }
  function delta(start, label) { const end=mark(); return {label, start_at:start.wall, end_at:end.wall, wall_ms:end.at-start.at, runtime_cpu_seconds:(end.totals.runtime-start.totals.runtime)/hz, browser_cpu_seconds:(end.totals.browser-start.totals.browser)/hz, runtime, browser, cadence_ms:cadence, tick_seconds:1/hz, observed_process_exits_or_gaps:end.gaps-start.gaps}; }
  return {mark,delta,close:()=>clearInterval(timer)};
}
