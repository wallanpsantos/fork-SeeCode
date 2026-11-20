// Utilitários de rede com proteção contra SSRF, DNS rebinding e redirects inseguros.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '::' || /^(fc|fd)[0-9a-f]{2}:/i.test(h) || /^fe[89ab][0-9a-f]:/i.test(h)) return true;
  const v4 = h.startsWith('::ffff:') ? h.slice(7) : h;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function resolvesToPrivate(hostname) {
  const clean = String(hostname || '').replace(/^\[|\]$/g, '');
  if (isIP(clean)) return isPrivateHost(clean);
  try {
    const addrs = await lookup(clean, { all: true });
    return addrs.some((a) => isPrivateHost(a.address));
  } catch {
    return false;
  }
}

export async function safeFetch(url, { allowPrivate = false, httpsOnly = false, timeoutMs = 10_000, maxRedirects = 5, headers = {} } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let cur = new URL(url);
    for (let hops = 0; ; hops++) {
      if (httpsOnly ? cur.protocol !== 'https:' : !/^https?:$/.test(cur.protocol)) {
        throw new Error(`unsupported scheme: ${cur.protocol}`);
      }
      if (!allowPrivate && (isPrivateHost(cur.hostname) || await resolvesToPrivate(cur.hostname))) {
        throw new Error(`blocked private host: ${cur.hostname}`);
      }
      const r = await fetch(cur.href, { signal: ctl.signal, redirect: 'manual', headers });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc || hops >= maxRedirects) throw new Error(`HTTP ${r.status}`);
        const next = new URL(loc, cur);
        if (cur.protocol === 'https:' && next.protocol === 'http:') throw new Error('blocked https-to-http redirect');
        cur = next;
        continue;
      }
      return r;
    }
  } finally {
    clearTimeout(t);
  }
}
