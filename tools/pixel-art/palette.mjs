/**
 * One shared limited palette, in ramps.
 *
 * The identity is warm off-white, near-black, transport red, restrained blue and warm greys.
 * A limited palette is not a flat one: each core colour carries shadow / mid / highlight so
 * surfaces have volume. Light falls from the upper left throughout.
 */
export const PALETTE = {
  ".": null,

  // Ink and warm greys
  K: "#14110f", // outline, near-black
  L: "#241f1c",
  M: "#3b3530",
  N: "#565049",
  O: "#7b736a",
  P: "#a49b90",
  Q: "#c8c0b3",
  R: "#e6e0d4",
  W: "#f7f6f1", // warm off-white
  X: "#ffffff",

  // Transport red
  q: "#5e0a0e",
  r: "#8c1015",
  s: "#b3161b",
  t: "#e5242a",
  u: "#f4565b",
  v: "#ff9ba0",

  // Restrained blue
  a: "#0a2159",
  b: "#123c96",
  c: "#1557ff",
  d: "#4f7dff",
  e: "#9db6ff",

  // Glass
  f: "#232c38",
  g: "#3d5169",
  h: "#546c85",
  i: "#7d97ad",
  j: "#aac1d1",
  k: "#d6e4ee",

  // Foliage, kept near-black so trees stay editorial rather than storybook
  1: "#161c16",
  2: "#243024",
  3: "#3a4a36",
  4: "#556348",
  5: "#6f7d5a",

  // Masonry and render
  6: "#8a7d6a",
  7: "#a89982",
  8: "#c3b7a3",
  9: "#ded4c2",

  // Amber, for indicators, lit windows and the destination blind
  y: "#8a5a00",
  z: "#f2b134",
  Z: "#ffd97a",

  // Skin
  A: "#f0cba4",
  B: "#c99a6d",
  C: "#8d5f3c",
  D: "#5b3a24",

  // Sky
  S: "#e9eef1",
  T: "#f3f5f6",

  /*
   * Shadow, as alpha rather than as a colour. A shadow painted in a flat grey was lighter than
   * the asphalt it fell on, so every bus in the scene sat on a bright stripe that read as a
   * reflection. These darken whatever is underneath, which is what a shadow does.
   */
  "-": "#0d0b0947",
  "=": "#0d0b0926",
  "+": "#0d0b0968",
  /* Road paint: a wash over the asphalt, because a bus cage is painted on, not laid on. */
  "*": "#8c101552",
  "%": "#f2b13440",
};
