// "data"/"links" de uma spec apontam arquivos que o render lê e embute no
// HTML: só valem csv/tsv/json dentro do projeto da spec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSpec } from '../skills/seecode/scripts/lib/render.mjs';
import { importFile } from '../skills/seecode/scripts/lib/importers/import.mjs';

function layout() {
  const root = mkdtempSync(join(tmpdir(), 'sc-data-'));
  for (const d of ['proj/.git', 'proj/specs', 'proj/data', 'outside']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'proj/data/sales.csv'), 'region,total\nnorth,10\nsouth,7\n');
  writeFileSync(join(root, 'outside/secret.csv'), 'key,n\nDB_PASSWORD=hunter2,1\n');
  writeFileSync(join(root, 'proj/.env'), 'API_KEY,1\n');
  return root;
}

test('data files inside the spec project render', () => {
  const root = layout();
  const r = renderSpec({ type: 'bar', title: 'T', data: '../data/sales.csv' }, { specPath: join(root, 'proj/specs/chart.json') });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
});

test('data files outside the project, absolute or of another kind are refused', () => {
  const root = layout();
  const at = join(root, 'proj/specs/chart.json');
  mkdirSync(join(root, 'proj/.secrets'));
  writeFileSync(join(root, 'proj/.secrets/key.json'), '[{"k":"hunter2","v":1}]');
  writeFileSync(join(root, 'proj/.env.json'), '[{"k":"hunter2","v":1}]');
  for (const bad of ['../../outside/secret.csv', join(root, 'outside/secret.csv'), '../.env', '../data/sales.txt', '../.secrets/key.json', '../.env.json', '../node_modules/x/data.json']) {
    const r = renderSpec({ type: 'bar', title: 'T', data: bad }, { specPath: at });
    assert.equal(r.ok, false, bad);
    assert.equal(r.problems[0].code, 'E_DATA', bad);
    assert.doesNotMatch(JSON.stringify(r), /hunter2/);
  }
  const s = renderSpec({ type: 'sankey', title: 'T', links: '../../outside/secret.csv' }, { specPath: at });
  assert.equal(s.ok, false);
});

test('a link inside the project that points outside is refused', (t) => {
  const root = layout();
  try {
    symlinkSync(join(root, 'outside'), join(root, 'proj/data/link'), 'junction');
  } catch {
    t.skip('this system cannot create links');
    return;
  }
  const r = renderSpec({ type: 'bar', title: 'T', data: '../data/link/secret.csv' }, { specPath: join(root, 'proj/specs/chart.json') });
  assert.equal(r.ok, false);
  assert.match(r.problems[0].msg, /fora do projeto/);
});

test('importing a CSV from outside the project copies it next to the spec', () => {
  const root = layout();
  const out = join(root, 'proj/specs/sales.json');
  const r = importFile(join(root, 'outside/secret.csv'), { out });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.notes.some((n) => /copied to sales\.data\.csv/.test(n)), JSON.stringify(r.notes));
  const spec = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(spec.data, 'sales.data.csv');
  assert.equal(renderSpec(spec, { specPath: out }).ok, true);
});

test('a spec that itself lives in a hidden folder can still read its own data', () => {
  const root = layout();
  mkdirSync(join(root, 'proj/.github/diagrams'), { recursive: true });
  writeFileSync(join(root, 'proj/.github/diagrams/sales.csv'), 'region,total\nnorth,10\n');
  const r = renderSpec({ type: 'bar', title: 'T', data: 'sales.csv' }, { specPath: join(root, 'proj/.github/diagrams/chart.json') });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
});

test('the home folder and the global ~/.seecode config never widen the data root', () => {
  const home = mkdtempSync(join(tmpdir(), 'sc-fakehome-'));
  mkdirSync(join(home, '.seecode'));
  writeFileSync(join(home, '.seecode/config.json'), '{}');
  mkdirSync(join(home, 'Documents'));
  writeFileSync(join(home, 'Documents/finances.csv'), 'item,v\nsalary,1\n');
  mkdirSync(join(home, 'downloads/specs'), { recursive: true });
  writeFileSync(join(home, 'downloads/specs/own.csv'), 'item,v\na,1\n');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SEECODE_HOME: process.env.SEECODE_HOME };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.SEECODE_HOME;
  try {
    const at = join(home, 'downloads/specs/chart.json');
    const out = renderSpec({ type: 'bar', title: 'T', data: '../../Documents/finances.csv' }, { specPath: at });
    assert.equal(out.ok, false);
    assert.match(out.problems[0].msg, /fora do projeto/);
    // sem projeto, a pasta da própria spec continua valendo
    assert.equal(renderSpec({ type: 'bar', title: 'T', data: 'own.csv' }, { specPath: at }).ok, true);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
