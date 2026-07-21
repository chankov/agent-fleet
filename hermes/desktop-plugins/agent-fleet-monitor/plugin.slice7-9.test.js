import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../..');

function loadPlugin(React) {
  const source = fs.readFileSync(path.join(directory, 'plugin.js'), 'utf8')
    .replace("import React, { useEffect, useState } from 'react';", 'const { useEffect, useState } = React;')
    .replace("import { present } from './state.js';", 'const present = (value) => value.error ? { kind: \'error\', message: value.error } : value.loading ? { kind: \'loading\' } : !value.tasks?.length ? { kind: \'empty\' } : { kind: \'tasks\', tasks: value.tasks };')
    .replace('export default ', 'return ');
  return new Function('React', source)(React);
}

function mountPane({ value = { loading: true }, ctx }) {
  const effects = []; let current = value;
  const React = {
    useState: () => [current, next => { current = next; }],
    useEffect: effect => effects.push(effect),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  };
  const plugin = loadPlugin(React); const registrations = [];
  plugin.register({ ...ctx, register: entry => registrations.push(entry) });
  const outer = registrations[0].render(); const view = outer.type(outer.props);
  const cleanups = effects.map(effect => effect()).filter(Boolean);
  return { registrations, view, unmount: () => cleanups.forEach(cleanup => cleanup()) };
}

function fakeDocument() {
  const listeners = new Map();
  return {
    visibilityState: 'visible',
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    setVisibility(value) { this.visibilityState = value; listeners.get('visibilitychange')?.(); },
  };
}

test('manifest-loaded hidden dashboard bridge registers a non-placeholder pane implementation', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'hermes/plugins/agent-fleet-monitor/dashboard/manifest.json'), 'utf8'));
  assert.equal(manifest.tab.hidden, true);
  const bundle = fs.readFileSync(path.join(root, 'hermes/plugins/agent-fleet-monitor/dashboard', manifest.entry), 'utf8');
  assert.match(bundle, /register\("agent-fleet-monitor"/);
  assert.doesNotMatch(bundle, /Placeholder|return null/);
});

test('mounted document-visible pane polls metadata every second, fetches output only after cursor advance, pauses hidden, resumes visible, and cleans up on unmount', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const originalDocument = globalThis.document; const document = fakeDocument(); globalThis.document = document;
  const calls = [];
  try {
    const mounted = mountPane({ ctx: { rest: async (route, body) => { calls.push([route, body]); return route === '/snapshot' ? { tasks: [{ id: 'child', generation: 2, outputSequence: 1 }] } : { sequence: 1, text: 'one' }; } } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); t.mock.timers.tick(1000); await Promise.resolve();
    assert.deepEqual(calls.filter(([route]) => route === '/snapshot').length, 2, 'visible mounted pane must poll at 1s');
    assert.deepEqual(calls.filter(([route]) => route.startsWith('/output?')).map(([route]) => new URLSearchParams(route.split('?')[1]).get('after_sequence')), ['0'], 'only advanced cursor fetches output');
    document.setVisibility('hidden'); t.mock.timers.tick(5000); await Promise.resolve();
    assert.equal(calls.filter(([route]) => route === '/snapshot').length, 2, 'hidden pane must pause polling');
    document.setVisibility('visible'); t.mock.timers.tick(1000); await Promise.resolve();
    assert.equal(calls.filter(([route]) => route === '/snapshot').length, 3, 'visible pane resumes polling');
    mounted.unmount(); t.mock.timers.tick(5000); await Promise.resolve();
    assert.equal(calls.filter(([route]) => route === '/snapshot').length, 3, 'unmounted pane disposes polling');
  } finally { globalThis.document = originalDocument; }
});

test('loading empty and error render semantic status/alert states', () => {
  assert.equal(mountPane({ value: { loading: true }, ctx: { rest: async () => ({}) } }).view.props.role, 'status');
  assert.equal(mountPane({ value: { tasks: [] }, ctx: { rest: async () => ({}) } }).view.props.role, 'status');
  assert.equal(mountPane({ value: { error: 'offline' }, ctx: { rest: async () => ({}) } }).view.props.role, 'alert');
});

test('flat bridge snapshot flows through fake ctx.rest to hierarchy, cursor output, and generation-safe cancel', async () => {
  const originalDocument=globalThis.document, calls=[]; globalThis.document=fakeDocument(); const flat={tasks:[{id:'parent',generation:1,state:'running',outputSequence:0,firstSequence:0,truncated:false,canCancel:false},{id:'child',generation:2,parentId:'parent',specialist:'qa',state:'running',outputSequence:1,firstSequence:1,truncated:false,canCancel:true}]};
  try { const mounted=mountPane({ctx:{rest:async(route,body)=>{calls.push([route,body]);return route==='/snapshot'?flat:route.startsWith('/output?')?{text:'visible',sequence:1,firstSequence:1,truncated:false}:{cancelled:true};}}}); await Promise.resolve(); await Promise.resolve(); assert.deepEqual(calls.slice(0,2),[['/snapshot',undefined],["/output?task_id=child&generation=2&after_sequence=0",undefined]]); mounted.unmount(); } finally { globalThis.document=originalDocument; }
});

test('recovering and orphaned tasks expose accessible state text and orphaned cannot cancel',()=>{const tasks=[{id:'r',generation:1,state:'recovering',canCancel:true},{id:'o',generation:1,state:'orphaned',canCancel:true}];const {view}=mountPane({value:{tasks},ctx:{rest:async()=>({})}});assert.match(String(view.children[0].children),/Recovering connection/);assert.match(String(view.children[1].children),/Task orphaned/);assert.equal(view.children[1].children.some(x=>x?.props?.['aria-label']),false);});
test('task hierarchy renders accessible tree/treeitems, bounded output, and keyboard-operable generation-safe authenticated cancel', () => {
  const requests = []; const task = { id: 'child', generation: 2, parentId: 'parent', state: 'running', output: 'bounded output', canCancel: true };
  const { view } = mountPane({ value: { tasks: [task] }, ctx: { rest: async (route, body) => { requests.push([route, body]); return { cancelled: true, state: 'cancelled' }; } } });
  assert.equal(view.props.role, 'tree');
  const row = view.children[0]; assert.equal(row.props.role, 'treeitem');
  assert.match(String(row.children), /bounded output/);
  const cancel = row.children.find(child => child?.props?.['aria-label'] === 'Cancel child generation 2');
  assert.ok(cancel, 'cancel button needs an accessible generation label');
  cancel.props.onKeyDown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(requests, [["/cancel?task_id=child&generation=2", { method: 'POST' }]], 'cancel must use only authenticated local REST route/task generation, never lifecycle APIs');
});
