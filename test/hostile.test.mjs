// Entradas hostis que antes derrubavam ou travavam o processo: zip bomb num
// draw.io e ids de evidence com nomes do protótipo de Object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { parseDrawio, MAX_XML_BYTES } from '../skills/seecode/scripts/lib/importers/canvas.mjs';
import { renderSpec } from '../skills/seecode/scripts/lib/render.mjs';

test('draw.io: compressed pages inflate only up to a ceiling (zip bomb)', () => {
  const model = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="A" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel>';
  // o conteúdo de <diagram> é XML url-encoded e deflate-raw, como o draw.io grava
  const doc = (pad) => `<mxfile><diagram name="p">${deflateRawSync(Buffer.from(encodeURIComponent(model) + 'x'.repeat(pad)), { level: 9 }).toString('base64')}</diagram></mxfile>`;
  assert.equal(parseDrawio(doc(1000)).nodes.length, 1);
  // passou do teto: a página é recusada em vez de inflada
  assert.equal(parseDrawio(doc(MAX_XML_BYTES)).nodes?.length ?? 0, 0);
});

test('evidence ids are plain keys, even "__proto__" and "constructor"', () => {
  const r = renderSpec({
    type: 'architecture', title: 'T', nodes: [{ id: 'a', label: 'A', row: 0, col: 0 }],
    evidence: [{ id: '__proto__', file: 'a.js' }, { id: 'constructor', file: 'b.js', line: 2 }, { id: 'a', file: 'c.js' }],
  });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  const meta = JSON.parse(/<script type="application\/json" id="sc-meta">([\s\S]*?)<\/script>/.exec(r.html)[1]);
  assert.deepEqual(Object.keys(meta.evidence).sort(), ['__proto__', 'a', 'constructor']);
});

test('every encoder the viewer imports from a CDN is pinned by an SRI hash', async () => {
  const { readFileSync } = await import('node:fs');
  const { ENCODER_INTEGRITY } = await import('../skills/seecode/scripts/lib/page.mjs');
  const client = readFileSync(new URL('../skills/seecode/scripts/lib/viewer/viewer.client.js', import.meta.url), 'utf8');
  const urls = [...client.matchAll(/'(https:\/\/cdn\.jsdelivr\.net\/[^']+)'/g)].map((m) => m[1]);
  assert.equal(urls.length, 3);
  for (const u of urls) assert.match(ENCODER_INTEGRITY[u] || '', /^sha384-[A-Za-z0-9+/]{64}$/, u);
  const html = renderSpec({ type: 'architecture', title: 'T', nodes: [{ id: 'a', label: 'A', row: 0, col: 0 }] }).html;
  const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.deepEqual(map, { integrity: ENCODER_INTEGRITY });
  // o import map vem antes do script do viewer, que é quem faz os imports
  assert.ok(html.indexOf('type="importmap"') < html.indexOf('const __scScopeCss'));
});
