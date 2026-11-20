// safeFetch contra SSRF: endereços privados em qualquer notação, DNS que
// aponta para a rede interna (inclusive rebinding), redirects, falha de DNS,
// e limites de tamanho e de tempo da resposta inteira.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { isBlockedAddress, isPrivateHost, redirectTarget, safeFetch } from '../skills/seecode/scripts/lib/net.mjs';

test('private and reserved addresses are blocked in every notation', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', '::ffff:7f00:1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '::7f00:1', '64:ff9b::7f00:1', 'fc00::1', 'fd12::1', 'fe80::1', 'fec0::1', 'ff02::1', '2002:7f00:1::']) {
    assert.equal(isBlockedAddress(a), true, a);
  }
  for (const a of ['8.8.8.8', '1.1.1.1', '::ffff:808:808', '2606:4700::1111', '2001:4860:4860::8888']) assert.equal(isBlockedAddress(a), false, a);
  assert.equal(isBlockedAddress('not-an-ip'), true);
});

test('hosts known to be internal without DNS', () => {
  for (const h of ['localhost', 'app.localhost', 'printer.local', 'db.internal', 'devbox', '[::ffff:7f00:1]', '[::1]', '127.0.0.1', 'router.lan']) assert.equal(isPrivateHost(h), true, h);
  for (const h of ['example.com', 'fonts.googleapis.com', '8.8.8.8']) assert.equal(isPrivateHost(h), false, h);
});

test('redirects never downgrade https to http', () => {
  assert.throws(() => redirectTarget(new URL('https://a.example/x'), 'http://a.example/y'), /https-to-http/);
  assert.equal(redirectTarget(new URL('https://a.example/x'), '/y').href, 'https://a.example/y');
});

// servidor local que conta cada requisição recebida
async function server(handler) {
  const hits = [];
  const srv = createServer((req, res) => { hits.push(req.url); handler(req, res); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { hits, port: srv.address().port, close: () => { srv.closeAllConnections(); return new Promise((r) => srv.close(r)); } };
}

// "public.test" resolve para o servidor local, que este teste trata como
// público; qualquer outro endereço segue a regra real
const net = (map = {}) => ({
  lookup: (host, opts, cb) => (map[host] ? cb(null, [].concat(map[host]).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))) : cb(Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' }))),
  isBlocked: (ip) => ip !== '127.0.0.1' && isBlockedAddress(ip),
});

test('an IPv4-mapped IPv6 literal no longer reaches localhost', async () => {
  const s = await server((req, res) => res.end('SECRET'));
  try {
    await assert.rejects(safeFetch(`http://[::ffff:127.0.0.1]:${s.port}/`), /blocked private host/);
    await assert.rejects(safeFetch(`http://[::ffff:7f00:1]:${s.port}/`), /blocked private host/);
    assert.deepEqual(s.hits, []);
  } finally {
    await s.close();
  }
});

test('DNS answers are checked at connect time (rebinding and fail-closed)', async () => {
  const s = await server((req, res) => res.end('SECRET'));
  try {
    // um nome "público" que resolve para a rede interna é barrado
    await assert.rejects(safeFetch(`http://rebind.test:${s.port}/`, net({ 'rebind.test': '10.0.0.5' })), /blocked private host/);
    // um registro público mais um privado também
    await assert.rejects(safeFetch(`http://mixed.test:${s.port}/`, net({ 'mixed.test': ['127.0.0.1', '192.168.0.10'] })), /blocked private host/);
    // falha de DNS bloqueia em vez de deixar passar
    await assert.rejects(safeFetch(`http://nowhere.test:${s.port}/`, net()), /ENOTFOUND/);
    assert.deepEqual(s.hits, []);
    // e o endereço validado é exatamente o usado na conexão
    const ok = await safeFetch(`http://public.test:${s.port}/`, net({ 'public.test': '127.0.0.1' }));
    assert.equal(await ok.text(), 'SECRET');
  } finally {
    await s.close();
  }
});

test('every redirect hop is checked again', async () => {
  const s = await server((req, res) => {
    const to = { '/to-mapped': `http://[::ffff:127.0.0.1]:${req.socket.localPort}/`, '/to-name': `http://inside.test:${req.socket.localPort}/`, '/loop': '/loop' }[req.url];
    if (to) res.writeHead(302, { location: to }).end();
    else res.end('SECRET');
  });
  try {
    const opts = net({ 'public.test': '127.0.0.1', 'inside.test': '169.254.169.254' });
    await assert.rejects(safeFetch(`http://public.test:${s.port}/to-mapped`, opts), /blocked private host/);
    await assert.rejects(safeFetch(`http://public.test:${s.port}/to-name`, opts), /blocked private host/);
    await assert.rejects(safeFetch(`http://public.test:${s.port}/loop`, { ...opts, maxRedirects: 2 }), /too many redirects/);
    assert.ok(!s.hits.includes('/'), JSON.stringify(s.hits));
  } finally {
    await s.close();
  }
});

test('the whole body is bounded in size and time', async () => {
  const s = await server((req, res) => {
    if (req.url === '/big') { res.write(Buffer.alloc(600_000, 97)); res.end(Buffer.alloc(600_000, 97)); }
    else if (req.url === '/gzip-bomb') res.writeHead(200, { 'content-encoding': 'gzip' }).end(gzipSync(Buffer.alloc(50_000_000)));
    else if (req.url === '/stall') { res.write('partial'); /* nunca termina */ }
    else res.end('ok');
  });
  const opts = { allowPrivate: true };
  try {
    await assert.rejects(safeFetch(`http://127.0.0.1:${s.port}/big`, { ...opts, maxBytes: 1_000_000 }), /larger than/);
    const cut = await safeFetch(`http://127.0.0.1:${s.port}/big`, { ...opts, maxBytes: 1_000_000, overflow: 'truncate' });
    assert.equal((await cut.arrayBuffer()).byteLength, 1_000_000);
    await assert.rejects(safeFetch(`http://127.0.0.1:${s.port}/gzip-bomb`, { ...opts, maxBytes: 1_000_000 }), /larger|buffer|output/i);
    const t = Date.now();
    await assert.rejects(safeFetch(`http://127.0.0.1:${s.port}/stall`, { ...opts, timeoutMs: 300 }), /timed out/);
    assert.ok(Date.now() - t < 3000);
  } finally {
    await s.close();
  }
});

test('https-only callers refuse plain http', async () => {
  await assert.rejects(safeFetch('http://fonts.googleapis.com/css2', { httpsOnly: true }), /unsupported scheme/);
});
