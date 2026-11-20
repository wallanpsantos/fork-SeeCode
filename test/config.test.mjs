import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home, proj, config;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'sc-home-'));
  proj = mkdtempSync(join(tmpdir(), 'sc-proj-'));
  mkdirSync(join(proj, '.git'));
  process.env.SEECODE_HOME = home;
  config = await import('../skills/seecode/scripts/lib/config/config.mjs');
});

test('first run is detected, then never again', () => {
  assert.equal(config.status(proj).state, 'first-run');
  config.init(proj, 'global');
  assert.equal(config.status(proj).state, 'inherits-global');
  assert.deepEqual(JSON.parse(readFileSync(join(proj, '.seecode/config.json'), 'utf8')), { inherit: 'global' });
});

test('project settings override global, global overrides defaults', () => {
  config.init(proj, 'global');
  config.set(proj, 'fps', '24', { global: true });
  assert.equal(config.status(proj).settings.fps, 24);
  config.set(proj, 'fps', '12');
  const s = config.status(proj);
  assert.equal(s.state, 'project');
  assert.equal(s.settings.fps, 12);
  assert.equal(s.settings.skin, 'light');
});

test('list values and unknown keys', () => {
  config.init(proj, 'project');
  assert.deepEqual(config.set(proj, 'exportFormats', 'html,gif').settings.exportFormats, ['html', 'gif']);
  assert.throws(() => config.set(proj, 'colour', 'red'), /unknown setting/);
});

test('loadProfile rejects path traversal slugs', () => {
  assert.equal(config.loadProfile('../package'), null);
  assert.equal(config.loadProfile('..\\..\\etc\\passwd'), null);
});

// .seecode/config.json chega com o repositório: quem clona não escreveu esse
// arquivo, então nada nele pode virar HTML ou sair da pasta do projeto.
const writeProject = (obj) => {
  mkdirSync(join(proj, '.seecode'), { recursive: true });
  writeFileSync(join(proj, '.seecode/config.json'), JSON.stringify(obj));
};

test('brand from a project config is data: only hex roles reach the page', async () => {
  writeProject({
    brand: {
      accent: '#ff0000',
      link: 'red;}</style><script>alert(1)</script>',
      'x}</style><script>alert(2)</script><style>': '#ffffff',
      dark: { accent: '#00ff00', paper: 'url(javascript:alert(3))' },
      fonts: { sans: { family: "Evil'</style><script>" } },
    },
  });
  const s = config.status(proj).settings;
  assert.deepEqual(Object.keys(s.brand).sort(), ['accent', 'dark', 'fonts']);
  assert.deepEqual(s.brand.dark, { accent: '#00ff00' });
  const { renderSpec } = await import('../skills/seecode/scripts/lib/render.mjs');
  const html = renderSpec({ type: 'architecture', title: 'T', nodes: [{ id: 'a', label: 'A', row: 0, col: 0 }] }, { settings: s }).html;
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /--sc-accent:#ff0000/);
});

test('skin tokens never carry markup, even from raw settings', async () => {
  const { skinCss } = await import('../skills/seecode/scripts/lib/tokens.mjs');
  const css = skinCss({ brand: { accent: '#123456', link: 'red}</style><script>x()</script>', 'a}</style><script>y()</script>': '#fff' } });
  assert.doesNotMatch(css, /<|script/);
  assert.match(css, /--sc-accent:#123456/);
});

test('a project config cannot send outputDir outside the project', () => {
  for (const bad of ['/etc', 'C:\\Windows', 'D:relative', '../../elsewhere', 'a/../../b', 'a\\..\\..\\b']) {
    writeProject({ outputDir: bad });
    assert.equal(config.status(proj).settings.outputDir, 'diagrams', bad);
  }
  writeProject({ outputDir: 'docs/diagrams' });
  assert.equal(config.status(proj).settings.outputDir, 'docs/diagrams');
});

test('an absolute outputDir chosen in the global config still works per project', () => {
  const abs = join(home, 'out');
  config.set(proj, 'outputDir', abs, { global: true });
  config.init(proj, 'project');
  assert.equal(config.status(proj).settings.outputDir, abs);
});
