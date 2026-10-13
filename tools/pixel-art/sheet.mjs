import { wideScene, tallScene, VEHICLES, GEOMETRY } from "./scene.mjs";
import { shoot } from "./preview.mjs";

const wide = wideScene();
wide.blit(VEHICLES.far, 150, GEOMETRY.WIDE.h - 12 - 22);
wide.blit(VEHICLES.near, 30, GEOMETRY.WIDE.h - 32);

const tall = tallScene();
tall.blit(VEHICLES.far, 92, GEOMETRY.TALL.h - 24 - 22);
tall.blit(VEHICLES.near, 4, GEOMETRY.TALL.h - 32);

await shoot(
  [
    { name: "wide 3x (as desktop)", rows: wide.rows(), scale: 3 },
    { name: "tall 2x (as phone)", rows: tall.rows(), scale: 2 },
  ],
  "art-preview/scene.png",
);
console.log("ok");
