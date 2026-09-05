import type { StopWeather, WeatherAdviceKind } from "@busstops/contracts";
import { describeCondition, weatherAdvice, weatherConditionKind } from "@busstops/adapters";
import {
  ACCESSORY_ANCHORS,
  ART,
  PEOPLE_META,
  PERSON_SIZE,
  VIGNETTE_SIZE,
} from "./pixel/sprites/generated.js";
import "./WeatherVignette.css";

/**
 * The weather at this stop, as one small picture and the numbers behind it.
 *
 * One shelter, one person, and a weather layer — not a landscape. The hero on the home page is a
 * street with three planes of depth; this sits beside a paragraph and has one job, which is to
 * say what it is like standing there right now.
 *
 * The person is chosen from the stop and the date and from nothing else. That is a deliberate
 * constraint rather than an implementation convenience: making the cast depend on the weather
 * would mean deciding which kinds of people go out in the rain, and the answer is all of them.
 */

/** Which accessory the weather puts in the scene, and which pose the person needs for it. */
const ACCESSORY_FOR: Record<WeatherAdviceKind, { name: string; pose: "plain" | "holding" } | null> =
  {
    rain: { name: "umbrella", pose: "holding" },
    snow: { name: "woollyHat", pose: "plain" },
    cold: { name: "woollyHat", pose: "plain" },
    uv: { name: "sunHat", pose: "plain" },
    hot: { name: "sunglasses", pose: "plain" },
    wind: { name: "scarf", pose: "plain" },
    fog: null,
    none: null,
  };

/** Which effect layers the sky gets. Order matters: far behind near. */
const EFFECTS_FOR: Record<WeatherAdviceKind, Array<keyof typeof ART>> = {
  rain: ["effect_rainFar", "effect_rainNear"],
  snow: ["effect_snow"],
  fog: ["effect_fog"],
  wind: ["effect_wind"],
  uv: ["effect_sun"],
  hot: ["effect_heat", "effect_sun"],
  cold: [],
  none: [],
};

/** Deterministic on the stop and the day. Never on the weather. */
function personIndexFor(atcoCode: string, serviceDate: string): number {
  const seed = `${atcoCode}:${serviceDate}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % PEOPLE_META.length;
}

export interface WeatherVignetteProps {
  weather: StopWeather;
  atcoCode: string;
  /** Art pixels per CSS pixel. Whole numbers only — a fractional scale is not pixel art. */
  scale?: 3 | 4;
  now?: Date;
}

export function WeatherVignette({
  weather,
  atcoCode,
  scale = 4,
  now = new Date(),
}: WeatherVignetteProps) {
  const hour = weather.current;
  const advice = weatherAdvice(hour);
  const condition = describeCondition(hour.weatherCode);
  const kind = weatherConditionKind(hour.weatherCode);

  const serviceDate = now.toISOString().slice(0, 10);
  const person = PEOPLE_META[personIndexFor(atcoCode, serviceDate)]!;
  const accessory = ACCESSORY_FOR[advice.kind];
  const pose = accessory?.pose === "holding" ? "holding" : "plain";
  const personArt = ART[`person_${person.id.replace(/-/g, "_")}_${pose}`]!;
  const backdrop = hour.isDay ? ART.vignetteDay! : ART.vignetteNight!;

  const PERSON_W_HALF = PERSON_SIZE.w / 2;
  const width = VIGNETTE_SIZE.w * scale;
  const height = VIGNETTE_SIZE.h * scale;

  // The person stands on the pavement, a little right of the shelter's near post.
  const personLeft = 62 * scale;
  const personTop = (VIGNETTE_SIZE.ground - PERSON_SIZE.h + 3) * scale;

  const accessoryArt = accessory ? ART[`accessory_${accessory.name}`]! : null;

  /*
   * Where an accessory lands.
   *
   * Each one declares what it attaches to and each character declares where that is, so an
   * umbrella hangs from the hand that is holding it and a scarf sits at the throat. The first
   * composition offset everything from the sprite's top by a guess, which put the umbrella off
   * the top of the picture and the scarf above the head like a flag.
   */
  const accessoryStyle = (() => {
    if (!accessory || !accessoryArt) return null;
    const anchorName = ACCESSORY_ANCHORS[accessory.name] ?? "head";
    const point =
      anchorName === "hand"
        ? person.hand
        : anchorName === "eyes"
          ? person.eyes
          : anchorName === "neck"
            ? person.neck
            : { x: Math.floor(PERSON_W_HALF), y: person.headTop };

    // The umbrella hangs from its handle; everything else is centred on its own anchor point.
    const offsetX =
      anchorName === "hand" ? Math.floor(accessoryArt.w / 2) : Math.floor(accessoryArt.w / 2);
    const offsetY = anchorName === "hand" ? accessoryArt.h - 2 : Math.floor(accessoryArt.h / 2);

    return {
      left: personLeft + (point.x - offsetX) * scale,
      top: personTop + (point.y - offsetY) * scale,
    };
  })();

  return (
    <figure
      className={`vignette vignette--${advice.kind}`}
      style={{ width, height: "auto" }}
      data-condition={kind}
      data-person={person.id}
    >
      <div className="vignette__scene" style={{ width, height }}>
        <img
          className="vignette__backdrop"
          src={backdrop.src}
          width={width}
          height={height}
          alt=""
        />

        {EFFECTS_FOR[advice.kind].map((name, index) => {
          const art = ART[name]!;
          return (
            <img
              key={name}
              className={`vignette__effect vignette__effect--${name.replace("effect_", "")}`}
              src={art.src}
              width={art.w * scale}
              height={art.h * scale}
              // The sun sits top-left; every other effect covers the whole scene.
              style={
                name === "effect_sun"
                  ? { left: 4 * scale, top: 2 * scale }
                  : { left: 0, top: 0, animationDelay: `${index * -0.7}s` }
              }
              alt=""
            />
          );
        })}

        <img
          className="vignette__person"
          src={personArt.src}
          width={PERSON_SIZE.w * scale}
          height={PERSON_SIZE.h * scale}
          style={{ left: personLeft, top: personTop }}
          alt=""
        />

        {accessoryArt && accessoryStyle ? (
          <img
            className="vignette__accessory"
            src={accessoryArt.src}
            width={accessoryArt.w * scale}
            height={accessoryArt.h * scale}
            style={accessoryStyle}
            alt=""
          />
        ) : null}
      </div>

      <figcaption className="vignette__caption">
        <p className="vignette__reading">
          <strong>{Math.round(hour.temperatureCelsius)}°C</strong>
          <span className="muted">feels like {Math.round(hour.apparentTemperatureCelsius)}°C</span>
          <span>{condition}</span>
        </p>

        {advice.message ? (
          <p className="vignette__advice">
            {advice.message}
            {advice.because.length > 0 ? (
              <span className="vignette__because muted small"> {advice.because.join(" · ")}</span>
            ) : null}
          </p>
        ) : null}

        {/* Every published number, so the picture is never the only thing said. */}
        <dl className="vignette__facts">
          <div>
            <dt>Rain</dt>
            <dd>
              {hour.precipitationMm.toFixed(1)} mm
              {hour.precipitationProbability === null
                ? ""
                : ` · ${hour.precipitationProbability}% chance`}
            </dd>
          </div>
          <div>
            <dt>Wind</dt>
            <dd>
              {Math.round(hour.windSpeedKph)} km/h
              {hour.windGustKph === null ? "" : ` · gusts ${Math.round(hour.windGustKph)}`}
            </dd>
          </div>
          <div>
            <dt>UV</dt>
            <dd>{hour.uvIndex === null ? "Not published" : hour.uvIndex.toFixed(1)}</dd>
          </div>
          <div>
            <dt>Daylight</dt>
            <dd>{hour.isDay ? "Daytime" : "After dark"}</dd>
          </div>
        </dl>

        <p className="vignette__source small muted">
          For the {weather.cellSizeDegrees}° area around this stop, read{" "}
          <time dateTime={weather.retrievedAt}>
            {new Date(weather.retrievedAt).toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
          . {weather.attribution}.
        </p>
      </figcaption>
    </figure>
  );
}
