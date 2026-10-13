import { deflateSync } from "node:zlib";

/**
 * A minimal PNG writer, so the artwork ships as an image rather than as tens of thousands of
 * SVG rectangles.
 *
 * The composed street is 46,000 pixels. Rendering it as one <rect> per run came to nearly
 * eighteen thousand elements across the sprite set, which is a great deal of DOM for one
 * illustration and buys nothing: pixel art wants `image-rendering: pixelated` and integer
 * scaling, and an image gives exactly that with no anti-aliasing anywhere.
 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function hex(value) {
  const h = value.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** rows: char grid. palette: char -> "#rrggbb" or null for transparent. */
export function encodePng(rows, palette) {
  const h = rows.length;
  const w = rows[0].length;
  const lut = new Map();
  for (const [ch, colour] of Object.entries(palette)) lut.set(ch, colour ? hex(colour) : null);

  // Filter type 0 on every scanline: pixel art is flat runs, and deflate handles those already.
  const raw = Buffer.alloc(h * (1 + w * 4));
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      const rgb = lut.get(rows[y][x]);
      if (rgb) {
        raw[p++] = rgb[0];
        raw[p++] = rgb[1];
        raw[p++] = rgb[2];
        raw[p++] = 255;
      } else {
        p += 4;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
