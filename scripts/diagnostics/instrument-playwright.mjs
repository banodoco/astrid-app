// Diagnostic-only, exact Playwright 1.60.0 bundle patch. Never used by CI automatically.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const bundle = resolve(process.argv[2] ?? 'node_modules/playwright-core/lib/coreBundle.js');
const pkg = JSON.parse(readFileSync(resolve(dirname(bundle), '../package.json'), 'utf8'));
const input = readFileSync(bundle, 'utf8');
const expected = 'f74353fcb8e406756a70a6af0dfc4a5069acd577e35ec9d923ccf36ac009c2f5';
if (pkg.version !== '1.60.0' || createHash('sha256').update(input).digest('hex') !== expected) throw new Error('Unsupported Playwright bundle');
let output = input;
function replace(anchor, replacement) {
  if (output.split(anchor).length !== 2) throw new Error('Playwright instrumentation anchor mismatch');
  output = output.replace(anchor, replacement);
}
// All failures in the observer are contained; collision or logging failure invalidates diagnostic evidence.
const helper = `
const __r12 = (() => {
  let n = 0, invalid = false;
  const objects = new WeakMap(), ids = new Map(), guids = new Map();
  const obj = o => { if (!o) return 0; if (!objects.has(o)) objects.set(o, ++n); return objects.get(o); };
  const net = (manager, id) => { let m = ids.get(manager); if (!m) ids.set(manager, m = new Map()); if (!m.has(id)) m.set(id, ++n); return m.get(id); };
  const emit = (event, fields = {}) => { try { require('fs').writeSync(2, 'PW_R12 ' + JSON.stringify({event, process: process.pid, ...fields}) + '\\n'); } catch { invalid = true; } };
  const guid = g => { const x = parseInt(require('crypto').createHash('sha256').update(g).digest('hex').slice(0, 12), 16); const prior = guids.get(x); if (prior !== undefined && prior !== g) { invalid = true; emit('collision'); } else guids.set(x, g); return x; };
  return { obj, net, emit, guid, get invalid() { return invalid; } };
})();
`;
replace('"use strict";\nvar __create', '"use strict";\n' + helper + 'var __create');
replace('        const sessionInfo = { session: session2, isMain, workerFrame, eventListeners: [] };', '        __r12.emit("session-add", { session: __r12.obj(session2) });\n        const sessionInfo = { session: session2, isMain, workerFrame, eventListeners: [] };');
replace('      removeSession(session2) {\n        const info = this._sessions.get(session2);', '      removeSession(session2) {\n        __r12.emit("session-remove", { session: __r12.obj(session2) });\n        const info = this._sessions.get(session2);');
replace('      _onRequestWillBeSent(sessionInfo, event) {', '      _onRequestWillBeSent(sessionInfo, event) {\n        __r12.emit("will-send", { request: __r12.net(this, event.requestId), session: __r12.obj(sessionInfo.session) });');
replace('      _onRequestPaused(sessionInfo, event) {', '      _onRequestPaused(sessionInfo, event) {\n        __r12.emit("paused", { request: event.networkId ? __r12.net(this, event.networkId) : 0, route: __r12.net(sessionInfo.session, event.requestId), session: __r12.obj(sessionInfo.session) });');
replace('        this._requestIdToRequest.set(requestWillBeSentEvent.requestId, request2);', '        __r12.emit("created", { request: __r12.net(this, requestWillBeSentEvent.requestId), object: __r12.obj(request2.request), route: requestPausedEvent ? __r12.net(requestPausedSessionInfo.session, requestPausedEvent.requestId) : 0, session: __r12.obj(requestWillBeSentSessionInfo.session) });\n        this._requestIdToRequest.set(requestWillBeSentEvent.requestId, request2);');
replace('      _deleteRequest(request2) {\n        this._requestIdToRequest.delete(request2._requestId);', '      _deleteRequest(request2) {\n        __r12.emit("deleted", { request: __r12.net(this, request2._requestId), object: __r12.obj(request2.request), session: __r12.obj(request2.session) });\n        this._requestIdToRequest.delete(request2._requestId);');
replace('      _onLoadingFinished(sessionInfo, event) {\n        this._responseExtraInfoTracker.loadingFinished(event);', '      _onLoadingFinished(sessionInfo, event) {\n        __r12.emit("loading-finished", { request: __r12.net(this, event.requestId), session: __r12.obj(sessionInfo.session), hit: this._requestIdToRequest.has(event.requestId) ? 1 : 0 });\n        this._responseExtraInfoTracker.loadingFinished(event);');
replace('      _onLoadingFailed(sessionInfo, event) {\n        this._responseExtraInfoTracker.loadingFailed(event);', '      _onLoadingFailed(sessionInfo, event) {\n        __r12.emit("loading-failed", { request: __r12.net(this, event.requestId), session: __r12.obj(sessionInfo.session), hit: this._requestIdToRequest.has(event.requestId) ? 1 : 0 });\n        this._responseExtraInfoTracker.loadingFailed(event);');
replace('          await this._session.send("Fetch.failRequest", {\n            requestId: this._interceptionId,\n            errorReason\n          });', '          __r12.emit("fail-begin", { route: __r12.net(this._session, this._interceptionId), session: __r12.obj(this._session) });\n          try {\n            await this._session.send("Fetch.failRequest", { requestId: this._interceptionId, errorReason });\n            __r12.emit("fail-success", { route: __r12.net(this._session, this._interceptionId), session: __r12.obj(this._session) });\n          } catch (error) {\n            __r12.emit("fail-rejected", { route: __r12.net(this._session, this._interceptionId), session: __r12.obj(this._session) });\n            throw error;\n          }');
replace('        this._type_Request = true;\n        this._browserContextDispatcher = scope;', '        __r12.emit("dispatcher", { object: __r12.obj(request2), guid: __r12.guid(this._guid) });\n        this._type_Request = true;\n        this._browserContextDispatcher = scope;');
// Guard argument evaluation too: observer failures must never affect Playwright.
output = output.replace(/^(\s*)__r12\.emit\(([^\n]+)\);$/gm, '$1if (process.env.PW_R12_DIAGNOSTICS === \"1\") { try { __r12.emit($2); } catch {} }');
writeFileSync(bundle, output);
