import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const iconsDir = path.resolve(import.meta.dirname, '..', 'icons');
fs.mkdirSync(iconsDir, { recursive: true });

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPng(size, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowSize = 1 + size * 4;
  const raw = Buffer.alloc(rowSize * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * rowSize;
    raw[rowStart] = 0;
    for (let x = 0; x < size; x += 1) {
      const dx = x - size / 2;
      const dy = y - size / 2;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const inCircle = dist < size * 0.38;
      const offset = rowStart + 1 + x * 4;
      raw[offset] = inCircle ? rgba[0] : 17;
      raw[offset + 1] = inCircle ? rgba[1] : 17;
      raw[offset + 2] = inCircle ? rgba[2] : 17;
      raw[offset + 3] = inCircle ? rgba[3] : 0;
    }
  }

  const compressed = deflateSync(raw);

  function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuffer = Buffer.from(type);
    const crcBuffer = Buffer.alloc(4);
    crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([length, typeBuffer, data, crcBuffer]);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [48, 128]) {
  const png = createPng(size, [124, 77, 255, 255]);
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), png);
}

console.log('Icons generated in icons/');
