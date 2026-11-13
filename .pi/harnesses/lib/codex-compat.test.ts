import test from 'node:test';
import assert from 'node:assert/strict';
import {assessCodexVersion,compareCodexVersions} from './codex-compat.ts';

const policy = (minimum = '0.166.0', denylist: readonly string[] = []) => ({minimum, denylist});
const allowed = {eligible: true, reason: 'meets_minimum'};
const rejected = (reason: string) => ({eligible: false, reason});

const precedence = [
 '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta',
 '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0',
];

test('SemVer canonical prerelease precedence is symmetric and transitive', () => {
 for (let i = 0; i < precedence.length; i++) {
  for (let j = 0; j < precedence.length; j++) {
   const expected = i === j ? 0 : i < j ? -1 : 1;
   assert.equal(compareCodexVersions(precedence[i], precedence[j]), expected, `${precedence[i]} vs ${precedence[j]}`);
  }
 }
});

test('Codex alpha components compare numerically; shorter prereleases precede extensions', () => {
 for (const [lower, higher] of [
  ['0.166.0-alpha.5.1', '0.166.0-alpha.6'],
  ['0.167.0-alpha.3.2', '0.167.0-alpha.3.10'],
  ['0.167.0-alpha.9', '0.167.0-alpha.10'],
  ['0.167.0-alpha.10', '0.167.0'],
  ['0.167.0-alpha', '0.167.0-alpha.0'],
  ['0.167.0-9', '0.167.0-alpha'],
  ['0.167.0-A', '0.167.0-a'],
 ]) {
  assert.equal(compareCodexVersions(lower, higher), -1);
  assert.equal(compareCodexVersions(higher, lower), 1);
 }
});

test('major/minor/patch precedence dominates prerelease fields', () => {
 for (const [lower, higher] of [
  ['0.166.99', '0.167.0-alpha.1'],
  ['0.167.0', '0.167.1-alpha.1'],
  ['0.999.999', '1.0.0-alpha'],
 ]) {
  assert.equal(compareCodexVersions(lower, higher), -1);
  assert.equal(compareCodexVersions(higher, lower), 1);
 }
});

test('numeric core and prerelease identifiers do not lose integer precision', () => {
 for (const [lower, higher] of [
  ['9007199254740992.0.0', '9007199254740993.0.0'],
  ['0.9007199254740992.0', '0.9007199254740993.0'],
  ['0.0.9007199254740992', '0.0.9007199254740993'],
  ['1.0.0-alpha.9007199254740992', '1.0.0-alpha.9007199254740993'],
  ['1.0.0-alpha.99', '1.0.0-alpha.100'],
 ]) {
  assert.equal(compareCodexVersions(lower, higher), -1);
  assert.equal(compareCodexVersions(higher, lower), 1);
 }
});

test('valid build metadata does not affect precedence or minimum eligibility', () => {
 for (const [left, right] of [
  ['0.167.1', '0.167.1+build.001'],
  ['0.167.0-alpha.3.2+001', '0.167.0-alpha.3.2+different'],
  ['1.0.0+00', '1.0.0+00.abc-def'],
 ]) {
  assert.equal(compareCodexVersions(left, right), 0);
  assert.equal(compareCodexVersions(right, left), 0);
  assert.deepEqual(assessCodexVersion(left, policy(right)), allowed);
 }
 for (const version of ['1.0.0--', '1.0.0-0A', '1.0.0-00x', '1.0.0+-']) {
  assert.equal(compareCodexVersions(version, version), 0);
 }
});

const invalidVersions: unknown[] = [
 undefined, null, true, 167, {}, [], ['0.167.1'], new String('0.167.1'),
 '', '0', '0.167', '0.167.1.0', 'v0.167.1', 'codex-cli 0.167.1',
 'Codex Desktop/0.167.1 (Linux)', ' 0.167.1', '0.167.1 ', '0.167.1\n',
 '0.167.1\r\n', '0.167.1\0', '0.167.1\t', '0.167.1\u2028',
 '00.167.1', '0.0167.1', '0.167.01', '-1.0.0', '+1.0.0',
 '1.0.0-', '1.0.0-alpha..1', '1.0.0-alpha.01', '1.0.0-00',
 '1.0.0+', '1.0.0+build..1', '1.0.0+build+other', '1.0.0+build/other',
 '>=0.166.0', '^0.167.1', '0.167.x', '*', 'latest', '1.0.0-alpha_1', '1.0.0+build_1',
 '1.0.0-алфа', '1.0.0-α', '１.0.0', '1.0.0-' + 'x'.repeat(251),
];

test('malformed, wrapped, non-string and oversized versions are not normalized into eligibility', () => {
 for (const version of invalidVersions) {
  assert.equal(compareCodexVersions(version, '0.167.1'), undefined, String(version));
  assert.equal(compareCodexVersions('0.167.1', version), undefined, String(version));
  assert.deepEqual(assessCodexVersion(version, policy()), rejected('invalid_version'), String(version));
 }
});

test('version parsing enforces the documented 256 ASCII character input boundary', () => {
 const version = '1.2.3+' + 'a'.repeat(250);
 assert.equal(version.length, 256);
 assert.equal(compareCodexVersions(version, '1.2.3'), 0);
 assert.deepEqual(assessCodexVersion(version, policy()), allowed);
 assert.equal(compareCodexVersions(version + 'a', '1.2.3'), undefined);
 assert.deepEqual(assessCodexVersion(version + 'a', policy()), rejected('invalid_version'));
});

test('minimum is inclusive without an implicit upper ceiling or major-version policy', () => {
 for (const version of ['0.166.0', '0.167.0-alpha.3.2', '0.167.1', '1.0.0', '2.0.0-alpha']) {
  assert.deepEqual(assessCodexVersion(version, policy()), allowed);
 }
 for (const version of ['0.165.99', '0.166.0-alpha.6']) {
  assert.deepEqual(assessCodexVersion(version, policy()), rejected('below_minimum'));
 }
 assert.deepEqual(assessCodexVersion('0.167.0-alpha.3.2', policy('0.167.0')), rejected('below_minimum'));
 assert.deepEqual(assessCodexVersion('0.166.0-alpha.5.1', policy('0.166.0-alpha.5.1')), allowed);
 assert.deepEqual(assessCodexVersion('0.166.0-alpha.5.0', policy('0.166.0-alpha.5.1')), rejected('below_minimum'));
});

test('denylist wins over minimum and cannot be bypassed through build metadata', () => {
 for (const [version, denied] of [
  ['0.167.1', '0.167.1'],
  ['0.167.1+good', '0.167.1'],
  ['0.167.1', '0.167.1+bad'],
  ['0.167.1+good', '0.167.1+bad'],
  ['0.167.0-alpha.3.2+good', '0.167.0-alpha.3.2+bad'],
 ]) {
  assert.deepEqual(assessCodexVersion(version, policy('0.166.0', [denied])), rejected('denied_version'));
 }
 assert.deepEqual(assessCodexVersion('0.165.0', policy('0.166.0', ['0.165.0'])), rejected('denied_version'));
 assert.deepEqual(assessCodexVersion('0.167.2', policy('0.166.0', ['0.167.1'])), allowed);
 assert.deepEqual(assessCodexVersion('0.167.0-alpha.3.3', policy('0.166.0', ['0.167.0-alpha.3.2'])), allowed);
});

test('missing, malformed or excessive policy data fails closed, even for a valid new version', () => {
 const invalidPolicies: unknown[] = [
  undefined, null, true, [], {}, {minimum: '0.166.0'}, {denylist: []},
  {minimum: '0.166.0', denylist: [], allow: true},
  policy('0.166.0', Array(1)),
  policy('0.166.0', Array(129).fill('0.165.0')),
  Object.create({minimum: '0.166.0', denylist: []}),
  ...invalidVersions.map(minimum => ({minimum, denylist: []})),
  ...invalidVersions.map(entry => ({minimum: '0.166.0', denylist: [entry]})),
  ...[null, {}, '0.167.1'].map(denylist => ({minimum: '0.166.0', denylist})),
 ];
 for (const invalid of invalidPolicies) {
  assert.deepEqual(assessCodexVersion('0.167.1', invalid), rejected('invalid_policy'));
 }
 // A corrupt entry must not be hidden by an earlier valid match.
 assert.deepEqual(assessCodexVersion('0.167.1', {minimum: '0.166.0', denylist: ['0.167.1', 'broken']}), rejected('invalid_policy'));
 assert.deepEqual(assessCodexVersion('broken', undefined), rejected('invalid_policy'));
});

test('bounded explicit policy is deterministic and not mutated, including frozen inputs', () => {
 const denylist = Object.freeze(['0.167.0', '0.167.0+duplicate']);
 const input = Object.freeze(policy('0.166.0', denylist));
 assert.deepEqual(assessCodexVersion('0.167.1', input), allowed);
 assert.deepEqual(assessCodexVersion('0.167.1', input), allowed);
 assert.deepEqual(input, {minimum: '0.166.0', denylist: ['0.167.0', '0.167.0+duplicate']});
 assert.deepEqual(assessCodexVersion('0.168.0', policy('0.166.0', Array.from({length: 128}, (_, i) => `0.167.${i}`))), allowed);
});
