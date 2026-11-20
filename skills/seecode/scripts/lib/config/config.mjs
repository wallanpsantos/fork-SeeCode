// Settings: built-in defaults ← global (~/.seecode) ← project (.seecode/).
// A project's first run is detected by the absence of .seecode/config.json;
// the skill then asks the user once and calls init().
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve, isAbsolute } from 'node:path';

export const DEFAULTS = {
  skin: 'light',
  motion: 'auto',
  exportFormats: ['html', 'png'],
  size: 'auto',
  scale: 'auto',
  fps: 30,
  duration: 'auto',
  outputDir: 'diagrams',
  profile: null,
  watermark: true,
  fonts: 'google',
};

const FONTS = ['google', 'system'];

const KNOWN = new Set(Object.keys(DEFAULTS).concat(['brand']));

export function globalDir() {
  return process.env.SEECODE_HOME || join(homedir(), '.seecode');
}

export function projectRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.seecode', 'config.json')) || existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start);
    dir = up;
  }
}

function readJson(path) {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
}

export function paths(cwd) {
  const root = projectRoot(cwd);
  return { root, project: join(root, '.seecode', 'config.json'), global: join(globalDir(), 'config.json'), profiles: join(globalDir(), 'profiles') };
}

const PROFILE_SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function loadProfile(slug) {
  if (!slug || !PROFILE_SLUG.test(String(slug))) return null;
  return readJson(join(globalDir(), 'profiles', `${slug}.json`));
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const BRAND_KEYS = ['accent', 'link', 'paper', 'ink', 'muted'];

// Brand profile: ~/.seecode/profiles/<slug>.json = {brand:{accent,link,paper,ink,muted}, dark?:{…}}
function cleanRoles(roles, label) {
  const clean = {};
  for (const k of BRAND_KEYS) {
    if (roles[k] === undefined) continue;
    if (!HEX.test(roles[k])) throw new Error(`${label}${k} must be a hex colour like #e4572e`);
    clean[k] = roles[k];
  }
  return clean;
}

// Fonts are stored as data, then sanitised: plain family names, Google Fonts
// stylesheet URLs, and @font-face rules whose files are https URLs.
export function cleanFonts(fonts) {
  if (!fonts) return null;
  const out = {};
  for (const role of ['sans', 'serif', 'mono']) {
    const f = fonts[role];
    const family = f && String(f.family || f).replace(/["'<>;{}\\]/g, '').trim().slice(0, 60);
    if (family) out[role] = { family, ...(f.source ? { source: String(f.source).slice(0, 60) } : {}) };
  }
  const href = [].concat(fonts.href || []).filter((h) => /^https:\/\/fonts\.googleapis\.com\/css2\?[\w+:;@.,&=%-]+$/.test(h)).slice(0, 4);
  if (href.length) out.href = href;
  const faces = (String(fonts.faces || '').match(/@font-face\s*\{[^{}<]*\}/g) || [])
    .filter((f) => !/(<\/style|<script|javascript:|expression\(|@import)/i.test(f) && [...f.matchAll(/url\(\s*"?([^")]+)"?\s*\)/g)].every((m) => /^https:\/\//.test(m[1])))
    .join('').slice(0, 20000);
  if (faces) out.faces = faces;
  return Object.keys(out).length ? out : null;
}

// Brand vindo de um config.json é dado, não código: o .seecode/config.json de
// um repositório clonado foi escrito por outra pessoa e vai parar dentro de
// <style>. Só ficam os papéis conhecidos com cor hex válida (como no
// saveProfile) e fontes sanitizadas; o resto é descartado.
export function cleanBrand(brand) {
  if (!brand || typeof brand !== 'object') return null;
  const roles = (src) => {
    const out = {};
    if (src && typeof src === 'object') for (const k of BRAND_KEYS) if (typeof src[k] === 'string' && HEX.test(src[k])) out[k] = src[k];
    return out;
  };
  const out = roles(brand);
  for (const mode of ['light', 'dark']) {
    const m = roles(brand[mode]);
    if (Object.keys(m).length) out[mode] = m;
  }
  const fonts = cleanFonts(brand.fonts);
  if (fonts) out.fonts = fonts;
  return Object.keys(out).length ? out : null;
}

// outputDir de um config de projeto: relativo e sem subir de pasta, para um
// repositório clonado não mandar o import gravar em outro lugar do disco.
const isProjectRelative = (v) => typeof v === 'string' && v.trim() !== '' && !isAbsolute(v) && !/^([a-zA-Z]:|[\\/])/.test(v) && !v.split(/[\\/]+/).includes('..');

export function saveProfile(slug, brand, { dark, source, fonts } = {}) {
  if (!PROFILE_SLUG.test(slug)) throw new Error('profile slug must be lowercase letters, digits, dashes');
  const clean = cleanRoles(brand, '');
  if (!Object.keys(clean).length) throw new Error(`give at least one of --${BRAND_KEYS.join(', --')}`);
  const file = join(globalDir(), 'profiles', `${slug}.json`);
  const prev = readJson(file) || {};
  const next = { ...prev, brand: { ...(prev.brand || {}), ...clean } };
  delete next.brand['accent-tint'];
  if (dark) next.dark = cleanRoles(dark, 'dark.');
  const f = cleanFonts(fonts);
  if (f) next.fonts = f;
  if (source) next.source = source;
  writeJson(file, next);
  return { slug, file, brand: next.brand, ...(next.dark ? { dark: next.dark } : {}), ...(next.fonts ? { fonts: next.fonts } : {}) };
}

export function listProfiles() {
  try {
    return readdirSync(join(globalDir(), 'profiles')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

export function status(cwd) {
  const p = paths(cwd);
  const g = readJson(p.global);
  const proj = readJson(p.project);
  let state = 'first-run';
  if (proj) state = proj.inherit === 'global' ? 'inherits-global' : 'project';
  const own = proj && proj.inherit !== 'global' ? proj : {};
  const settings = { ...DEFAULTS, ...(g || {}), ...own };
  delete settings.inherit;
  // o valor global (escolhido pelo próprio usuário) continua valendo quando o
  // init o copiou para o projeto
  if (own.outputDir !== undefined && own.outputDir !== g?.outputDir && !isProjectRelative(own.outputDir)) settings.outputDir = g?.outputDir ?? DEFAULTS.outputDir;
  const profile = loadProfile(settings.profile);
  const fromProfile = profile ? { ...(profile.brand || {}), ...(profile.dark ? { dark: profile.dark } : {}), ...(profile.fonts ? { fonts: profile.fonts } : {}) } : {};
  const brand = cleanBrand({ ...fromProfile, ...(settings.brand && typeof settings.brand === 'object' ? settings.brand : {}) });
  if (brand) settings.brand = brand;
  else delete settings.brand;
  return { state, root: p.root, hasGlobal: !!g, settings };
}

export function init(cwd, use) {
  const p = paths(cwd);
  if (!readJson(p.global)) writeJson(p.global, { ...DEFAULTS });
  if (use === 'global') writeJson(p.project, { inherit: 'global' });
  else writeJson(p.project, { ...DEFAULTS, ...(readJson(p.global) || {}) });
  return status(cwd);
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^[[{]/.test(v)) return JSON.parse(v);
  if (v.includes(',')) return v.split(',').map((s) => s.trim());
  return v;
}

export function set(cwd, key, value, { global = false } = {}) {
  if (!KNOWN.has(key)) throw new Error(`unknown setting "${key}" (known: ${[...KNOWN].join(', ')})`);
  if (key === 'fonts' && !FONTS.includes(value)) throw new Error(`fonts must be one of: ${FONTS.join(', ')}`);
  const p = paths(cwd);
  const file = global ? p.global : p.project;
  let cur = readJson(file) || (global ? { ...DEFAULTS } : {});
  if (!global && cur.inherit === 'global') cur = { ...DEFAULTS, ...(readJson(p.global) || {}) };
  delete cur.inherit;
  cur[key] = coerce(String(value));
  writeJson(file, cur);
  return status(cwd);
}
