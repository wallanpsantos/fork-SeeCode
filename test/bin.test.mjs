// Resolução de executáveis externos (ffmpeg, Chrome): só diretórios absolutos
// do PATH contam. No Windows, spawn('ffmpeg') procura antes na pasta atual,
// então um ffmpeg.exe deixado num repositório clonado rodaria no lugar do real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { findExecutable, ffmpegPath } from '../skills/seecode/scripts/lib/export/bin.mjs';
import { chromeCandidates } from '../skills/seecode/scripts/lib/export/chrome.mjs';

const EXT = process.platform === 'win32' ? '.exe' : '';

function fakeBin(dir, name) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name + EXT);
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, 0o755);
  return file;
}

test('PATH entries that mean "current folder" are never searched', () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-bin-'));
  const planted = fakeBin(join(root, 'repo'), 'ffmpeg');
  const real = fakeBin(join(root, 'tools'), 'ffmpeg');
  const cwd = process.cwd();
  process.chdir(join(root, 'repo'));
  try {
    const env = { PATH: ['', '.', 'repo', join(root, 'tools')].join(delimiter) };
    assert.equal(findExecutable('ffmpeg', { env }), real);
    assert.notEqual(findExecutable('ffmpeg', { env }), planted);
    assert.equal(findExecutable('ffmpeg', { env: { PATH: ['', '.'].join(delimiter) } }), null);
  } finally {
    process.chdir(cwd);
  }
});

test('SEECODE_FFMPEG must be an absolute path to a file', () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-bin-'));
  const real = fakeBin(root, 'my-ffmpeg');
  assert.equal(ffmpegPath({ SEECODE_FFMPEG: real, PATH: '' }), real);
  assert.equal(ffmpegPath({ SEECODE_FFMPEG: 'my-ffmpeg' + EXT, PATH: '' }), null);
});

test('Chrome candidates are absolute even when an env var is missing', () => {
  const list = chromeCandidates('win32', { PROGRAMFILES: 'C:\\Program Files' });
  assert.ok(list.length > 0);
  assert.ok(list.every((p) => /^[A-Za-z]:\\/.test(p)), JSON.stringify(list));
  assert.ok(!list.some((p) => p.startsWith('undefined')));
});
