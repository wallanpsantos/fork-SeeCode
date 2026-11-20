import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePatch, compactJson, outPathFor } from '../skills/seecode/scripts/lib/render.mjs';

const spec = { type: 'architecture', nodes: [{ id: 'a', label: 'A', row: 0, col: 0 }, { id: 'b', label: 'B', row: 0, col: 1 }], edges: [['a', 'b', 'x']] };

test('object merge and null delete', () => {
  assert.deepEqual(mergePatch({ a: 1, b: { c: 2 } }, { b: { d: 3 }, a: null }), { b: { c: 2, d: 3 } });
});

test('id-keyed array patch updates, removes and adds', () => {
  const out = mergePatch(spec, { nodes: { a: { col: 2 }, b: null, c: { label: 'C', row: 1, col: 0 } } });
  assert.deepEqual(out.nodes, [{ id: 'a', label: 'A', row: 0, col: 2 }, { id: 'c', label: 'C', row: 1, col: 0 }]);
  assert.equal(spec.nodes[0].col, 0, 'original untouched');
});

test('tuple arrays support add/remove by from>to and index', () => {
  assert.deepEqual(mergePatch(spec, { edges: { remove: ['a>b'], add: [['b', 'a']] } }).edges, [['b', 'a']]);
  assert.deepEqual(mergePatch(spec, { edges: { remove: [0] } }).edges, []);
});

test('compactJson keeps short items on one line and round-trips', () => {
  const s = compactJson(spec);
  assert.deepEqual(JSON.parse(s), spec);
  assert.ok(s.includes('{"id":"a","label":"A","row":0,"col":0}'));
});

test('mergePatch ignores prototype-pollution keys and outPathFor blocks traversal', () => {
  const payload = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}},"ok":1}');
  const out = mergePatch({}, payload);
  assert.equal({}.polluted, undefined);
  assert.equal(out.ok, 1);
  assert.throws(() => outPathFor({ out: '../../outside.html' }, '/tmp/work/spec.json'), /diretório de saída/);
  assert.equal(outPathFor({ out: 'sub/diagram.html' }, '/tmp/work/spec.json').endsWith('diagram.html'), true);
  // só .html, e nunca dentro de pastas ou arquivos ocultos
  for (const out of ['notes.txt', 'package.json', '.git/config', '.github/workflows/x.html', 'sub/.hidden.html', '..evil.html/../../x.html']) {
    assert.throws(() => outPathFor({ out }, '/tmp/work/spec.json'), /spec\.out/, out);
  }
  assert.ok(outPathFor({ out: 'Diagram.HTM' }, '/tmp/work/spec.json').endsWith('Diagram.HTM'));
});

test('outPathFor follows links inside the spec folder and refuses ones that lead out', async (t) => {
  const { mkdtempSync, mkdirSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'sc-out-'));
  mkdirSync(join(root, 'work'));
  mkdirSync(join(root, 'elsewhere'));
  try {
    symlinkSync(join(root, 'elsewhere'), join(root, 'work/link'), 'junction');
  } catch {
    t.skip('this system cannot create links');
    return;
  }
  assert.throws(() => outPathFor({ out: 'link/x.html' }, join(root, 'work/spec.json')), /diretório de saída/);
  assert.ok(outPathFor({ out: 'new/x.html' }, join(root, 'work/spec.json')).endsWith('x.html'));
});

test('the folder index links each diagram as a relative file, never a URL scheme', async () => {
  const { indexHtml } = await import('../skills/seecode/scripts/lib/folder.mjs');
  const html = indexHtml('set', [{ href: 'javascript:alert(document.domain)\n-->', title: 't', type: 'bar' }, { href: 'mapa #1.html', title: 'm', type: 'bar' }]);
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^https:/.test(u));
  assert.ok(refs.length >= 4);
  assert.ok(refs.every((u) => u.startsWith('./')), JSON.stringify(refs));
  assert.ok(refs.some((u) => u.startsWith('./mapa%20%231.html')));
  assert.doesNotMatch(html, /href="javascript:|src="javascript:/);
});
