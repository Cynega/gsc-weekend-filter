// Run once with: node generate_icons.js
// Generates simple PNG icons for the extension using only Node.js built-ins.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPNG(size) {
  // Draw a rounded-square icon: blue background (#1a73e8), white "W" letter
  const width = size;
  const height = size;

  // Create raw RGBA pixel data
  const pixels = Buffer.alloc(width * height * 4);

  const bg  = [0x1a, 0x73, 0xe8, 0xff]; // #1a73e8
  const fg  = [0xff, 0xff, 0xff, 0xff]; // white
  const rad = Math.round(size * 0.2);   // corner radius

  function inRoundedRect(x, y) {
    const cx = x - width / 2 + 0.5;
    const cy = y - height / 2 + 0.5;
    const rx = width / 2 - rad;
    const ry = height / 2 - rad;
    const dx = Math.max(0, Math.abs(cx) - rx);
    const dy = Math.max(0, Math.abs(cy) - ry);
    return dx * dx + dy * dy <= rad * rad;
  }

  // Simple "W" approximation using 5 vertical bars
  function inLetter(x, y) {
    const lx = (x / width  - 0.5) * 2; // -1..1
    const ly = (y / height - 0.5) * 2;
    if (ly < -0.55 || ly > 0.55) return false;

    const bars = [-0.72, -0.36, 0, 0.36, 0.72];
    const thick = 0.18;
    for (let i = 0; i < bars.length; i++) {
      if (Math.abs(lx - bars[i]) < thick / 2) {
        // Middle bars slope down toward center
        if (i === 1 && ly < lx + 0.18) return false;
        if (i === 3 && ly < -lx + 0.18) return false;
        return true;
      }
    }
    return false;
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (!inRoundedRect(x, y)) {
        // Transparent outside rounded rect
        pixels[idx] = pixels[idx+1] = pixels[idx+2] = pixels[idx+3] = 0;
      } else if (inLetter(x, y)) {
        pixels[idx]   = fg[0];
        pixels[idx+1] = fg[1];
        pixels[idx+2] = fg[2];
        pixels[idx+3] = fg[3];
      } else {
        pixels[idx]   = bg[0];
        pixels[idx+1] = bg[1];
        pixels[idx+2] = bg[2];
        pixels[idx+3] = bg[3];
      }
    }
  }

  // Build PNG file manually
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBytes = Buffer.from(type, 'ascii');
    const combined  = Buffer.concat([typeBytes, data]);
    const crc32 = computeCRC(combined);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32 >>> 0, 0);
    return Buffer.concat([len, typeBytes, data, crcBuf]);
  }

  // CRC-32 (PNG spec)
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  function computeCRC(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width,  0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8;  // bit depth
  ihdr[9]  = 6;  // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // Raw image data with filter byte per row
  const rawRows = [];
  for (let y = 0; y < height; y++) {
    rawRows.push(0); // filter type: None
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rawRows.push(pixels[i], pixels[i+1], pixels[i+2], pixels[i+3]);
    }
  }
  const idat = zlib.deflateSync(Buffer.from(rawRows));

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const iconsDir = path.join(__dirname, 'icons');
fs.mkdirSync(iconsDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const png = createPNG(size);
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), png);
  console.log(`icons/icon${size}.png (${png.length} bytes)`);
}
console.log('Done.');
