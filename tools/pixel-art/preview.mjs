import { chromium } from "playwright";
import { PALETTE } from "./palette.mjs";

/** Rows -> SVG, run-length encoded per row, exactly as the app will render them. */
export function rowsToSvg(rows, scale = 1, bg = "none") {
  const w = rows[0].length,
    h = rows.length;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">`;
  if (bg !== "none") out += `<rect width="${w}" height="${h}" fill="${bg}"/>`;
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      const ch = rows[y][x];
      let len = 1;
      while (x + len < w && rows[y][x + len] === ch) len++;
      const fill = PALETTE[ch];
      if (fill) out += `<rect x="${x}" y="${y}" width="${len}" height="1" fill="${fill}"/>`;
      x += len;
    }
  }
  return out + "</svg>";
}

export async function shoot(panels, file, { scale = 6, bg = "#f7f6f1" } = {}) {
  const body = panels
    .map(
      (p) =>
        `<figure><figcaption>${p.name} — ${p.rows[0].length}×${p.rows.length}</figcaption>${rowsToSvg(p.rows, p.scale ?? scale, p.bg ?? "none")}</figure>`,
    )
    .join("");
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:${bg};font:12px ui-monospace,monospace;padding:16px;display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start}
    figure{margin:0}
    figcaption{color:#66645f;margin-bottom:6px}
    svg{display:block;image-rendering:pixelated}
  </style>${body}`;
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1,
  });
  await page.setContent(html);
  await page.screenshot({ path: file, fullPage: true });
  await browser.close();
  return file;
}
