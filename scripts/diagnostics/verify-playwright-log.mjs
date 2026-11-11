// Reject incomplete or ambiguous diagnostic joins; print counts only.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const status = JSON.parse(readFileSync(join(dirname(process.argv[2]), 'collector-status.json'), 'utf8'));
if (status?.complete !== true || status?.invalid !== false || Object.keys(status).sort().join(',') !== 'complete,invalid') throw new Error('Incomplete or invalid diagnostic collector');
const text = readFileSync(process.argv[2], 'utf8');
const protocol = [], scanner = [];
for (const line of text.split('\n')) {
  for (const [prefix, target] of [['PW_R12 ', protocol], ['TOKEN_SNIFF ', scanner]]) {
    const at = line.indexOf(prefix);
    if (at !== -1) target.push(JSON.parse(line.slice(at + prefix.length)));
  }
}
if (!protocol.length || !scanner.length || protocol.some(x => x.event === 'collision')) throw new Error('Incomplete or ambiguous diagnostic records');
const processes = new Map();
for (const row of protocol) {
  if (!Number.isSafeInteger(row.process) || !Number.isSafeInteger(row.seq)) throw new Error('Incomplete observer identity');
  const rows = processes.get(row.process) ?? [];
  rows.push(row); processes.set(row.process, rows);
}
for (const rows of processes.values()) {
  if (rows[0].event !== 'observer-start' || rows.at(-1).event !== 'observer-end' || rows.at(-1).invalid !== 0 || rows.some((r, i) => r.seq !== i + 1 || (i > 0 && r.event === 'observer-start') || (i < rows.length - 1 && r.event === 'observer-end'))) throw new Error('Incomplete observer stream');
}
const dispatch = new Map(), created = new Map();
for (const row of protocol.filter(x => x.event === 'created')) {
  if (![row.process, row.object, row.request, row.route, row.session].every(Number.isSafeInteger) || row.object <= 0 || row.request <= 0 || row.route < 0 || row.session <= 0) throw new Error('Incomplete created request');
  const key = `${row.process}:${row.object}`;
  if (created.has(key)) throw new Error('Ambiguous created request');
  const sent = protocol.filter(x => x.event === 'will-send' && x.process === row.process && x.request === row.request && x.session === row.session);
  const paused = protocol.filter(x => x.event === 'paused' && x.process === row.process && x.request === row.request && x.route === row.route);
  if (!sent.length || (row.route > 0 && paused.length !== 1)) throw new Error('Incomplete network or route linkage');
  created.set(key, row);
}
for (const row of protocol.filter(x => x.event === 'dispatcher')) {
  const owner = `${row.process}:${row.object}`;
  if (!Number.isSafeInteger(row.guid) || !Number.isSafeInteger(row.object) || dispatch.has(row.guid)) throw new Error('Ambiguous diagnostic dispatcher');
  dispatch.set(row.guid, owner);
}
const requests = new Set(), joins = new Map(), blocked = new Set();
for (const row of scanner) {
  if (!['request', 'protocol-join', 'gate-entry'].includes(row.event)) continue;
  if (![row.process, row.scanner, row.request].every(Number.isSafeInteger)) throw new Error('Incomplete scanner identity');
  const id = `${row.process}:${row.scanner}:${row.request}`;
  if (row.event === 'request') requests.add(id);
  else if (row.event === 'gate-entry') blocked.add(id);
  else {
    const owner = dispatch.get(row.protocol);
    const entry = created.get(owner);
    if (joins.has(id) || !owner || !entry) throw new Error('Missing or ambiguous diagnostic join');
    joins.set(id, entry);
  }
}
if (!requests.size || requests.size !== joins.size || [...requests].some(id => !joins.has(id)) || [...blocked].some(id => !joins.has(id) || joins.get(id).route === 0)) throw new Error('Incomplete scanner joins');
console.log(`Verified ${requests.size} diagnostic request joins`);
