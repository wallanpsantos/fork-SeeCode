// Rede com defesa contra SSRF, para buscas a URLs que vêm de fora (brand
// onboarding, fontes de uma marca, arquivos do Google Fonts):
// - bloqueia endereços privados e reservados de IPv4 e IPv6, inclusive IPv4
//   escrito como IPv6 ([::ffff:7f00:1] é 127.0.0.1) e NAT64;
// - valida o IP dentro do lookup da própria conexão e conecta exatamente
//   nele: não existe segunda resolução de DNS, logo não há janela para DNS
//   rebinding; falha de DNS também bloqueia;
// - segue redirects à mão, revalidando cada salto e sem rebaixar https;
// - limita tempo e tamanho da resposta inteira, não só dos cabeçalhos.
import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';

// Faixas de uso especial (IANA) que uma URL vinda de fora nunca deve alcançar.
// Estes endereços são a própria lista de bloqueio, não destinos de conexão.
const BLOCKED_V4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
];
const BLOCKED_V6 = [
  '::/96', // não especificado, loopback e IPv4-compatível (::7f00:1)
  '64:ff9b::/96', '64:ff9b:1::/48', // NAT64
  '100::/64', // descarte
  '2001::/32', // Teredo (carrega um IPv4)
  '2001:db8::/32', // documentação
  '2002::/16', // 6to4 (carrega um IPv4)
  'fc00::/7', 'fe80::/10', 'fec0::/10', 'ff00::/8',
];
const BLOCKED = new BlockList();
for (const [family, list] of [['ipv4', BLOCKED_V4], ['ipv6', BLOCKED_V6]]) {
  for (const cidr of list) {
    const [net, prefix] = cidr.split('/');
    BLOCKED.addSubnet(net, Number(prefix), family);
  }
}

const bare = (h) => String(h || '').toLowerCase().replace(/^\[|\]$/g, '');

// Um IP (string) que cai em faixa privada ou reservada. Lixo conta como bloqueado.
export function isBlockedAddress(address) {
  const ip = bare(address);
  const v = isIP(ip);
  if (!v) return true;
  try {
    return BLOCKED.check(ip, v === 6 ? 'ipv6' : 'ipv4');
  } catch {
    return true;
  }
}

// Host que já se sabe interno sem consultar DNS: IP literal privado, nomes
// locais e nomes de um rótulo só (resolvidos pelos domínios de busca da rede).
export function isPrivateHost(hostname) {
  const h = bare(hostname).replace(/\.$/, '');
  if (!h) return true;
  if (isIP(h)) return isBlockedAddress(h);
  return !h.includes('.') || /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/.test(h);
}

// Próxima URL de um redirect; nunca rebaixa https para http.
export function redirectTarget(from, location) {
  const next = new URL(location, from);
  if (from.protocol === 'https:' && next.protocol === 'http:') throw new Error('blocked https-to-http redirect');
  return next;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY = new Set([204, 205, 304]);

// opts.lookup e opts.isBlocked existem para os testes simularem DNS e rede.
// overflow: 'error' rejeita respostas maiores que maxBytes; 'truncate' fica
// com os primeiros maxBytes (útil para ler só o começo de uma página).
export async function safeFetch(url, opts = {}) {
  const {
    allowPrivate = false, httpsOnly = false, timeoutMs = 10_000, maxRedirects = 5,
    maxBytes = 5_000_000, overflow = 'error', headers = {}, lookup = dnsLookup, isBlocked = isBlockedAddress,
  } = opts;
  const deadline = Date.now() + timeoutMs;
  let cur = new URL(url);
  for (let hops = 0; ; hops++) {
    assertTarget(cur, { httpsOnly, allowPrivate, isBlocked });
    const res = await request(cur, { allowPrivate, headers, lookup, isBlocked, maxBytes, overflow, deadline });
    if (REDIRECTS.has(res.status) && res.location) {
      if (hops >= maxRedirects) throw new Error(`HTTP ${res.status}: too many redirects`);
      cur = redirectTarget(cur, res.location);
      continue;
    }
    return new Response(NULL_BODY.has(res.status) ? null : res.body, { status: res.status, headers: res.headers });
  }
}

// Esquema permitido e host que não seja sabidamente interno (antes do DNS);
// vale para a URL inicial e para cada redirect.
function assertTarget(url, { httpsOnly, allowPrivate, isBlocked }) {
  const okScheme = httpsOnly ? url.protocol === 'https:' : /^https?:$/.test(url.protocol);
  if (!okScheme) throw new Error(`unsupported scheme: ${url.protocol}`);
  if (allowPrivate) return;
  const host = bare(url.hostname);
  const internal = isIP(host) ? isBlocked(host) : isPrivateHost(host);
  if (internal) throw new Error(`blocked private host: ${url.hostname}`);
}

function request(url, { allowPrivate, headers, lookup, isBlocked, maxBytes, overflow, deadline }) {
  return new Promise((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) return reject(new Error('request timed out'));
    // chamado pelo socket para resolver o host: o endereço validado aqui é o
    // mesmo em que a conexão é aberta
    const guardedLookup = (hostname, options, cb) => {
      lookup(hostname, { ...options, all: true }, (err, addrs) => {
        if (err) return cb(err);
        const list = (Array.isArray(addrs) ? addrs : []).filter((a) => !options.family || a.family === options.family);
        if (!list.length) return cb(Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }));
        if (!allowPrivate && list.some((a) => isBlocked(a.address))) return cb(new Error(`blocked private host: ${hostname}`));
        return options.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
      });
    };
    const mod = url.protocol === 'https:' ? https : http;
    let timer = null;
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const req = mod.request(url, { method: 'GET', headers, lookup: guardedLookup, agent: false }, (res) => {
      const status = res.statusCode;
      if (REDIRECTS.has(status) && res.headers.location) {
        res.resume();
        done(resolve, { status, location: res.headers.location });
        req.destroy();
        return;
      }
      if (status < 200 || status > 599) {
        done(reject, new Error(`unexpected HTTP status ${status}`));
        req.destroy();
        return;
      }
      const chunks = [];
      let size = 0;
      let truncated = false;
      const finish = () => {
        try {
          const raw = Buffer.concat(chunks);
          const enc = String(res.headers['content-encoding'] || '').trim().toLowerCase();
          if (truncated && enc && enc !== 'identity') throw new Error(`response larger than ${maxBytes} bytes`);
          done(resolve, { status, headers: toHeaders(res.headers), body: decode(raw, enc, maxBytes) });
        } catch (e) {
          done(reject, e);
        }
      };
      res.on('data', (c) => {
        if (truncated) return;
        if (size + c.length > maxBytes) {
          if (overflow !== 'truncate') {
            done(reject, new Error(`response larger than ${maxBytes} bytes`));
            req.destroy();
            return;
          }
          chunks.push(c.subarray(0, maxBytes - size));
          size = maxBytes;
          truncated = true;
          finish();
          req.destroy();
          return;
        }
        size += c.length;
        chunks.push(c);
      });
      res.on('end', finish);
      res.on('error', (e) => done(reject, e));
      res.on('aborted', () => done(reject, new Error('response aborted')));
    });
    timer = setTimeout(() => { done(reject, new Error('request timed out')); req.destroy(); }, left);
    req.on('error', (e) => done(reject, e));
    req.end();
  });
}

function toHeaders(raw) {
  const h = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || k === 'content-encoding' || k === 'content-length') continue;
    for (const x of [v].flat()) {
      try { h.append(k, x); } catch { /* cabeçalho inválido: ignora */ }
    }
  }
  return h;
}

// Corpo comprimido também respeita o limite depois de descomprimido.
function decode(buf, enc, maxBytes) {
  const opts = { maxOutputLength: maxBytes };
  if (!enc || enc === 'identity') return buf;
  if (enc === 'gzip' || enc === 'x-gzip') return gunzipSync(buf, opts);
  if (enc === 'deflate') return inflateSync(buf, opts);
  if (enc === 'br') return brotliDecompressSync(buf, opts);
  throw new Error(`unsupported content-encoding: ${enc}`);
}
