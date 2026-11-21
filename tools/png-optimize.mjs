#!/usr/bin/env node
// Recompressão PNG sem perda, sem dependências: decodifica (8 bits por canal,
// sem entrelaçamento), escolhe o melhor filtro por linha, recomprime com
// deflate nível 9 e só grava se os pixels decodificados forem idênticos.
// Usado por build-mark.mjs: o encoder do Chrome gera a marca d'água ~30% maior,
// e ela vai em base64 dentro de toda página e de todo SVG exportado.
//   node tools/png-optimize.mjs <arquivo.png>…
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }; // cinza, RGB, cinza+alfa, RGBA

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function predict(f, a, b, c) {
  if (f === 1) return a;
  if (f === 2) return b;
  if (f === 3) return (a + b) >> 1;
  if (f === 4) return paeth(a, b, c);
  return 0;
}

export function decodePng(buf) {
  let p = 8, ihdr = null;
  const idat = [], extra = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type !== 'IEND') extra.push(type);
    p += 12 + len;
  }
  const w = ihdr.readUInt32BE(0), h = ihdr.readUInt32BE(4), depth = ihdr[8], type = ihdr[9];
  if (depth !== 8 || ihdr[12] !== 0 || !CHANNELS[type]) throw new Error(`PNG não suportado (depth ${depth}, tipo ${type}, entrelaçado ${ihdr[12]})`);
  if (extra.length) throw new Error(`PNG com chunks auxiliares (${extra.join(', ')}): recompressão evitada para não perder metadados`);
  const bpp = CHANNELS[type], stride = w * bpp, raw = inflateSync(Buffer.concat(idat)), px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride), prev = y ? px.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0, c = x >= bpp ? prev[x - bpp] : 0;
      out[x] = (line[x] + predict(f, a, prev[x], c)) & 255;
    }
  }
  return { w, h, type, bpp, px };
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePng({ w, h, type, bpp, px }) {
  const stride = w * bpp, rows = [];
  for (let y = 0; y < h; y++) {
    const cur = px.subarray(y * stride, (y + 1) * stride), prev = y ? px.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    let best = null, bestCost = Infinity;
    // heurística da soma mínima dos resíduos (a do libpng)
    for (let f = 0; f < 5; f++) {
      const row = Buffer.alloc(stride + 1);
      row[0] = f;
      let cost = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0, c = x >= bpp ? prev[x - bpp] : 0;
        const v = (cur[x] - predict(f, a, prev[x], c)) & 255;
        row[x + 1] = v;
        cost += v < 128 ? v : 256 - v;
      }
      if (cost < bestCost) { bestCost = cost; best = row; }
    }
    rows.push(best);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = type;
  const idat = deflateSync(Buffer.concat(rows), { level: 9, memLevel: 9 });
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// Recomprime `file` no lugar se ficar menor com os mesmos pixels.
export function optimizePng(file) {
  const src = readFileSync(file);
  const img = decodePng(src);
  const out = encodePng(img);
  if (!decodePng(out).px.equals(img.px)) throw new Error(`recompressão alterou pixels: ${file}`);
  if (out.length < src.length) writeFileSync(file, out);
  return { file, before: src.length, after: Math.min(out.length, src.length) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const f of process.argv.slice(2)) console.log(JSON.stringify(optimizePng(f)));
}
