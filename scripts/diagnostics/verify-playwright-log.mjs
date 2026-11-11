// Reject incomplete or ambiguous diagnostic joins; print counts only.
import { readFileSync } from 'node:fs';
const text = readFileSync(process.argv[2], 'utf8');
const protocol = [], scanner = [];
for (const line of text.split('\n')) {
  for (const [prefix, target] of [['PW_R12 ', protocol], ['TOKEN_SNIFF ', scanner]]) {
    const at = line.indexOf(prefix);
    if (at !== -1) target.push(JSON.parse(line.slice(at + prefix.length)));
  }
}
if (!protocol.length || !scanner.length || protocol.some(x => x.event === 'collision')) throw new Error('Incomplete or ambiguous diagnostic records');
const dispatch = new Map();
for (const row of protocol.filter(x => x.event === 'dispatcher')) {
  const owner = `${row.process}:${row.object}`;
  const prior = dispatch.get(row.guid);
  if (!Number.isSafeInteger(row.guid) || !Number.isSafeInteger(row.process) || !Number.isSafeInteger(row.object) || (prior && prior !== owner)) throw new Error('Ambiguous diagnostic dispatcher');
  dispatch.set(row.guid, owner);
}
const requests = new Set(), joins = new Set();
for (const row of scanner) {
  if (row.event !== 'request' && row.event !== 'protocol-join') continue;
  if (![row.process, row.scanner, row.request].every(Number.isSafeInteger)) throw new Error('Incomplete scanner identity');
  const id = `${row.process}:${row.scanner}:${row.request}`;
  if (row.event === 'request') requests.add(id);
  else {
    if (joins.has(id) || !dispatch.has(row.protocol)) throw new Error('Missing or ambiguous diagnostic join');
    joins.add(id);
  }
}
if (!requests.size || requests.size !== joins.size || [...requests].some(id => !joins.has(id))) throw new Error('Incomplete scanner joins');
console.log(`Verified ${requests.size} diagnostic request joins`);
