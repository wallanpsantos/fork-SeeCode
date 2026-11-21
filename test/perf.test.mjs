// Guardas das otimizações de desempenho (determinísticas, sem medir tempo):
// a marca d'água vai uma vez só, os PNGs dela ficam recomprimidos e o
// escurecimento do viewer não volta a usar filtros SVG.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { renderSpec } from '../skills/seecode/scripts/lib/render.mjs';
import { VIEWER_CSS } from '../skills/seecode/scripts/lib/viewer/viewer.css.mjs';

const spec = { type: 'architecture', title: 'T', nodes: [{ id: 'a', label: 'A', row: 0, col: 0 }, { id: 'b', label: 'B', row: 0, col: 1 }], edges: [['a', 'b']] };

test('each embedded image appears once per page', () => {
  const html = renderSpec(spec).html;
  const uris = html.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/g) || [];
  assert.ok(uris.length >= 3, 'favicon and the two watermark images');
  assert.equal(new Set(uris).size, uris.length, 'no data URI repeated (href + xlink:href doubled ~33 KB)');
});

test('watermark PNGs stay losslessly recompressed', () => {
  const size = (f) => statSync(new URL(`../skills/seecode/assets/${f}`, import.meta.url)).size;
  // Chrome's encoder gives ~12 KB + 13 KB; tools/png-optimize.mjs gives ~8.8 KB + 8.6 KB
  assert.ok(size('mark-symbol.png') + size('mark-word.png') <= 18_500, 'run node tools/png-optimize.mjs on the marks');
});

test('viewer dimming uses opacity, not per-element SVG filters', () => {
  assert.doesNotMatch(VIEWER_CSS, /filter:\s*opacity\(/, 'filter:opacity() costs a filter surface per dimmed node/edge');
  assert.match(VIEWER_CSS, /\.sc-svg\.is-dim [^{]*\{opacity:\.14!important\}/);
  assert.ok(readFileSync(new URL('../tools/png-optimize.mjs', import.meta.url), 'utf8').includes('optimizePng'));
});
