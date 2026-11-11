// Diagnostic only: single-request HTTP/1.1 loopback TCP relay. Never log captured bytes.
// It does not supply browser event correlation or a release-check verdict.
const net = require('node:net');
function startTap(targetPort) {
  const records = [];
  const server = net.createServer(client => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    const r = { request: [], response: [], clientClosed: false, upstreamClosed: false, errors: [] };
    records.push(r);
    client.on('data', data => { r.request.push(Buffer.from(data)); upstream.write(data); });
    upstream.on('data', data => { r.response.push(Buffer.from(data)); client.write(data); });
    client.on('end', () => upstream.end());
    upstream.on('end', () => client.end());
    client.on('close', () => { r.clientClosed = true; upstream.destroy(); });
    upstream.on('close', () => { r.upstreamClosed = true; client.destroy(); });
    client.on('error', e => { r.errors.push('client:' + e.code); upstream.destroy(); });
    upstream.on('error', e => { r.errors.push('upstream:' + e.code); client.destroy(); });
  });
  return { server, records };
}
// Conservative parser rejects chunked, no-length, extra/pipelined bytes and incomplete messages.
function parseSingle(chunks, response = false) {
  const raw = Buffer.concat(chunks); const boundary = raw.indexOf('\r\n\r\n');
  if (boundary < 0) return { complete: false, reason: 'missing headers' };
  const head = raw.subarray(0, boundary).toString('latin1');
  const lines = head.split('\r\n'); const first = lines.shift();
  const headers = lines.map(line => { const n = line.indexOf(':'); return n < 1 ? null : [line.slice(0,n).toLowerCase(), line.slice(n+1).trim()]; });
  if (headers.includes(null) || headers.some(([k]) => k === 'transfer-encoding')) return { complete: false, reason: 'unsupported framing' };
  const lengths = headers.filter(([k]) => k === 'content-length').map(([,v]) => v);
  if (lengths.length > 1 || (lengths.length && !/^(0|[1-9]\d*)$/.test(lengths[0]))) return { complete: false, reason: 'ambiguous length' };
  // Without an explicit length only requests are confidently empty here.
  if (!lengths.length && response) return { complete: false, reason: 'response has no explicit length' };
  const expected = lengths.length ? Number(lengths[0]) : 0;
  if (!Number.isSafeInteger(expected)) return { complete: false, reason: 'invalid length' };
  const body = raw.subarray(boundary + 4);
  if (body.length !== expected) return { complete: false, reason: body.length < expected ? 'incomplete body' : 'extra bytes or pipelining' };
  return { complete: true, first, head, body };
}
module.exports = { startTap, parseSingle };
