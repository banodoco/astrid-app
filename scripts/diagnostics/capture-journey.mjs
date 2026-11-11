// Preserve only validated diagnostic records in artifacts, separately by stream,
// while forwarding the unmodified journey output to the existing job log.
import { spawn } from 'node:child_process';
import { openSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';

const [directory, command, ...args] = process.argv.slice(2);
if (!directory || !command) throw new Error('Diagnostic capture requires a directory and command');
mkdirSync(directory, { recursive: true });
const outputs = ['stdout', 'stderr', 'combined'].map(name => openSync(join(directory, `${name}.log`), 'wx'));
const protocolEvents = new Set(['observer-start','observer-end','collision','session-add','session-remove','will-send','paused','created','deleted','loading-finished','loading-failed','fail-begin','fail-success','fail-rejected','dispatcher']);
const scannerEvents = new Set(['request','main-frame-navigation-request','headers-begin','headers-end','headers-failed','requestfinished','requestfailed','response','body-begin','body-end','body-failed','main-frame-committed','domcontentloaded','load','page-close','page-crash','route-entry','drain-timeout','drain-pending-headers','drain-pending-body','drain-pending-route','drain-nonterminal-unclassified','drain-nonterminal-dispatched','drain-nonterminal-blocked','gate-entry','abort-begin','abort-end','abort-failed','gate-installed','navigation-begin','navigation-end','navigation-failed','gate-removed','gate-retained','protocol-join']);
let invalid = false;
function diagnostic(line) {
  const match = /(?:^|\s)(PW_R12|TOKEN_SNIFF) (\{.*\})\s*$/.exec(line);
  if (!match) {
    if (/\b(?:PW_R12|TOKEN_SNIFF)\b/.test(line)) invalid = true;
    return;
  }
  try {
    const data = JSON.parse(match[2]);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    const pw = match[1] === 'PW_R12';
    const keys = pw ? ['event','process','seq','invalid','session','request','route','object','guid','hit'] : ['event','process','scanner','request','label','navigation','time','protocol'];
    if (!Object.keys(data).every(key => keys.includes(key))) throw new Error();
    if (!(pw ? protocolEvents : scannerEvents).has(data.event)) throw new Error();
    for (const [key, value] of Object.entries(data)) {
      if (key === 'event') continue;
      if (key === 'label') {
        if (typeof value !== 'string' || !/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|OTHER) \/(commit|health|handshake|app-state\/:id|build\.json|install-manifest\.json|other) request$/.test(value)) throw new Error();
      } else if (!Number.isSafeInteger(value) || value < 0) throw new Error();
    }
    return `${match[1]} ${JSON.stringify(data)}\n`;
  } catch { invalid = true; }
}
function record(line, index) {
  const value = diagnostic(line);
  if (!value) return;
  try {
    for (const fd of [outputs[index], outputs[2]]) if (writeSync(fd, value) !== Buffer.byteLength(value)) invalid = true;
  } catch { invalid = true; }
}
const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'] });
for (const [index, stream] of [child.stdout, child.stderr].entries()) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  stream.on('data', chunk => {
    (index === 0 ? process.stdout : process.stderr).write(chunk);
    pending += decoder.write(chunk);
    const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines) record(line, index);
  });
  stream.on('end', () => { pending += decoder.end(); if (pending) record(pending, index); });
  stream.on('error', () => { invalid = true; });
}
child.on('error', () => { invalid = true; });
child.on('close', (code, signal) => {
  for (const fd of outputs) { try { closeSync(fd); } catch { invalid = true; } }
  if (invalid) process.stderr.write('Diagnostic capture incomplete or invalid\n');
  // Never turn a failing journey into a pass. Evidence errors fail a passing journey.
  process.exitCode = code && code > 0 ? code : signal ? 1 : invalid ? 1 : 0;
});
