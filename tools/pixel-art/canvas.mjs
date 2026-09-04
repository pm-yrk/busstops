/** A char-grid pixel canvas. One char = one art pixel. '.' is transparent. */
export class Canvas {
  constructor(w, h, fill = ".") {
    this.w = w;
    this.h = h;
    this.g = Array.from({ length: h }, () => Array(w).fill(fill));
  }
  px(x, y, c) {
    if (c === undefined || c === null) return;
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.g[y][x] = c;
  }
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return ".";
    return this.g[y][x];
  }
  rect(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c);
  }
  /** Rectangle border only. */
  frame(x, y, w, h, c) {
    this.hline(x, y, w, c);
    this.hline(x, y + h - 1, w, c);
    this.vline(x, y, h, c);
    this.vline(x + w - 1, y, h, c);
  }
  hline(x, y, len, c) {
    for (let i = 0; i < len; i++) this.px(x + i, y, c);
  }
  vline(x, y, len, c) {
    for (let i = 0; i < len; i++) this.px(x, y + i, c);
  }
  /** Bresenham line. */
  line(x0, y0, x1, y1, c) {
    let dx = Math.abs(x1 - x0),
      sx = x0 < x1 ? 1 : -1;
    let dy = -Math.abs(y1 - y0),
      sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.px(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }
  /** Filled disc, pixel-accurate. */
  disc(cx, cy, r, c) {
    for (let y = -r; y <= r; y++)
      for (let x = -r; x <= r; x++)
        if (x * x + y * y <= r * r + r * 0.35) this.px(cx + x, cy + y, c);
  }
  ring(cx, cy, r, c) {
    for (let y = -r; y <= r; y++)
      for (let x = -r; x <= r; x++) {
        const d = x * x + y * y;
        if (d <= r * r + r * 0.35 && d > (r - 1) * (r - 1) + (r - 1) * 0.35)
          this.px(cx + x, cy + y, c);
      }
  }
  /** Upper half-disc, for wheel arches. */
  archTop(cx, cy, r, c) {
    for (let y = -r; y <= 0; y++)
      for (let x = -r; x <= r; x++)
        if (x * x + y * y <= r * r + r * 0.35) this.px(cx + x, cy + y, c);
  }
  /** Replace one colour with another inside a box. */
  swap(x, y, w, h, from, to) {
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) if (this.get(x + i, y + j) === from) this.px(x + i, y + j, to);
  }
  /** Outline every opaque pixel that touches transparency (4-neighbour). */
  outline(c, over = null) {
    const copy = this.g.map((r) => r.slice());
    const solid = (x, y) => {
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
      return copy[y][x] !== ".";
    };
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        if (!solid(x, y)) continue;
        if (over !== null && copy[y][x] !== over) continue;
        if (!solid(x - 1, y) || !solid(x + 1, y) || !solid(x, y - 1) || !solid(x, y + 1))
          this.px(x, y, c);
      }
  }
  /** Copy another canvas's opaque pixels onto this one. */
  blit(src, x, y, { flip = false } = {}) {
    for (let j = 0; j < src.h; j++)
      for (let i = 0; i < src.w; i++) {
        const c = src.g[j][flip ? src.w - 1 - i : i];
        if (c !== ".") this.px(x + i, y + j, c);
      }
  }
  flipped() {
    const out = new Canvas(this.w, this.h);
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) out.g[y][x] = this.g[y][this.w - 1 - x];
    return out;
  }
  /** Scatter a colour with a stable pseudo-random pattern, for texture. */
  speckle(x, y, w, h, c, density, seed = 1) {
    let s = seed * 9301 + 49297;
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        s = (s * 9301 + 49297) % 233280;
        if (s / 233280 < density && this.get(x + i, y + j) !== ".") this.px(x + i, y + j, c);
      }
  }
  rows() {
    return this.g.map((r) => r.join(""));
  }
}
