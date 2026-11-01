// Pure controls for the actual mounted child-placement receipt helper; no browser or Runtime execution.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileFunction } from 'node:vm';
import { expect } from '@playwright/test';
import ts from 'typescript';

const source = readFileSync(new URL('../three-products.p2-elements-assets.spec.ts', import.meta.url), 'utf8');
const extract = (name) => {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `exercise the actual ${name} helper`);
  return match[0];
};
const object = compileFunction(`${ts.transpileModule(extract('object'), {}).outputText}\nreturn object;`, ['expect'])(expect);
const placementPublicationId = compileFunction(
  `${ts.transpileModule(extract('placementPublicationId'), {}).outputText}\nreturn placementPublicationId;`,
  ['expect', 'object'],
)(expect, object);

function post({ receipt = 'txn-placement', key = 'request-placement', receiptKey = key } = {}) {
  return { key, json: { data: {}, receipt: { receipt_id: receipt, idempotency_key: receiptKey } } };
}

test('actual placement receipt helper keeps publication and idempotency identities distinct', () => {
  assert.equal(placementPublicationId(post()), 'txn-placement');
  assert.throws(() => placementPublicationId(post({ receipt: 'request-placement' })), /Expected: not/);
  assert.throws(() => placementPublicationId(post({ receiptKey: 'wrong-request' })), /expect\(received\)\.toBe/);
});
