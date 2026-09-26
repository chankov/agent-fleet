import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
const root = new URL('../../catalog/', import.meta.url);
function walk(dir) {
 return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
  return entry.isDirectory() ? walk(url) : entry.name.endsWith('.md') ? [url] : [];
 });
}
test('catalogue Markdown has no source attribution and retains template metadata', () => {
 for (const file of walk(root)) {
  const body = readFileSync(file, 'utf8');
  assert.doesNotMatch(body, /^Source:|RankedIn|ringithub|STANDARDS\.md|source attribution/im, file.pathname);
  if (!file.pathname.endsWith('/README.md')) {
   assert.match(body, /^---\nfleet-template: [\w-]+\nfleet-source-version: \d+\n---\n/, file.pathname);
  }
 }
});
