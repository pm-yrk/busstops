import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { StopWeather, WeatherAdviceKind } from "@busstops/contracts";
import { describeCondition, weatherAdvice, weatherConditionKind } from "@busstops/adapters";
import {
  ACCESSORY_ANCHORS,
  ART,
  PEOPLE_META,
  PERSON_SIZE,
  VIGNETTE_SIZE,
  VIGNETTE_WORLD_SIZE,
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
  rain: ["effect_rainFar", "effect_rainNear", "effect_rainReflections"],
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
  /**
   * Null when no reading has been published for this stop.
   *
   * The scene is still drawn — a shelter and somebody waiting in it are true whatever the sky is
   * doing — but with no effect layer, no accessory and no numbers, and a plain statement that the
   * weather is unavailable. Hiding the whole section was the old behaviour and it made the product
   * look unfinished; inventing a condition to fill the space would be worse than either.
   */
  weather: StopWeather | null;
  atcoCode: string;
  /**
   * The largest number of CSS pixels per art pixel this may be drawn at.
   *
   * A maximum rather than a setting: the scene is 176 art pixels wide, so three of them is 528
   * CSS pixels — which fits a 560-pixel stop panel and does not fit a phone. The component drops
   * to the largest whole number that fits the space it is actually in. Whole numbers only: a
   * vignette scaled by 1.8 to fill the column would not be pixel art any more, it would be a
   * blurred photograph of some.
   */
  scale?: 2 | 3;
  now?: Date;
  /**
   * The panel version: the same picture and the same numbers, fewer of them.
   *
   * A selected stop on the map is answering "when is my bus", and the weather is the second
   * question, so it gets a band under the board rather than a full figure. Temperature, what it
   * feels like, the condition, rain, wind and one line of advice — which is what somebody
   * deciding whether to wait outside actually uses. UV, daylight and the reading time stay on the
   * stop page, where there is room for them.
   */
  compact?: boolean;
  /**
   * Whether a bus is actually due, which is the only condition under which one is drawn.
   *
   * The caller knows — the stop page and the map panel both hold the departures. A bus painted
   * into a scene where none is coming would be the picture telling a lie the rest of the product
   * is careful not to, and "there is a bus on the way" is worth saying when it is true.
   */
  busApproaching?: boolean;
  /**
   * Which composition of the same street to draw.
   *
   * "panel" is the portrait the map's stop board was designed around. "world" is the stop page's
   * wide view: the same shelter with the street it stands on either side of it, a skyline, a
   * lamp, a bench and a second tree. Same drawing code and the same weather; a different shape,
   * because a picture that works at 176 x 128 in a side panel is the wrong aspect entirely for
   * the full width of a page.
   */
  geometry?: "panel" | "world";
}

/**
 * The largest whole scale that fits the width the component was given.
 *
 * Measured rather than guessed from a media query, because the vignette sits in a column whose
 * width is decided by the page around it. Before the first measurement — and in a test renderer,
 * where nothing has a width — it stays at the maximum, which is the desktop case.
 */
function useFittingScale(available: number | null, maximum: number, artWidth: number): number {
  if (available === null || available <= 0) return maximum;
  return Math.max(1, Math.min(maximum, Math.floor(available / artWidth)));
}

export function WeatherVignette({
  weather,
  atcoCode,
  scale: maximumScale = 3,
  now = new Date(),
  compact = false,
  busApproaching = false,
  geometry = "panel",
}: WeatherVignetteProps) {
  const holder = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<number | null>(null);
  const world = geometry === "world";
  const size = world ? VIGNETTE_WORLD_SIZE : VIGNETTE_SIZE;
  const scale = useFittingScale(
    available,
    compact ? Math.min(2, maximumScale) : maximumScale,
    size.w,
  );

  useEffect(() => {
    const element = holder.current;
    if (!element) return;

    const measure = () => setAvailable(element.clientWidth || null);
    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const hour = weather?.current ?? null;
  const advice = hour ? weatherAdvice(hour) : null;
  const condition = hour ? describeCondition(hour.weatherCode) : null;
  const kind = hour ? weatherConditionKind(hour.weatherCode) : null;

  const serviceDate = now.toISOString().slice(0, 10);
  const person = PEOPLE_META[personIndexFor(atcoCode, serviceDate)]!;
  // No accessory without a reading: an umbrella is a claim that it is raining.
  const accessory = advice ? ACCESSORY_FOR[advice.kind] : null;
  const pose = accessory?.pose === "holding" ? "holding" : "plain";
  const personArt = ART[`person_${person.id.replace(/-/g, "_")}_${pose}`]!;
  /*
   * Day when nothing is known. Night is a statement about the time at that stop, and this
   * component is not in a position to make one without a reading.
   */
  const day = hour === null || hour.isDay;
  const backdrop = world
    ? day
      ? ART.vignetteWorldDay!
      : ART.vignetteWorldNight!
    : day
      ? ART.vignetteDay!
      : ART.vignetteNight!;

  const PERSON_W_HALF = PERSON_SIZE.w / 2;
  const width = size.w * scale;
  const height = size.h * scale;

  /*
   * The person stands on the pavement in the shelter's open side, under the roof's overhang.
   *
   * These were 62 and ground-minus-height in a 96-wide picture. The scene is 176 wide now, and
   * carrying the old numbers over would have stood everybody against the left-hand wall.
   */
  /*
   * Where the person stands, which is a different place in each composition.
   *
   * In the panel the shelter fills the frame and its open side is at 96. The world is the same
   * shelter drawn at the left of a wider street, so the open side is further left — standing the
   * character at 96 in that one puts them through the stop flag.
   */
  const personLeft = (world ? 74 : 96) * scale;
  const personTop = (size.ground - PERSON_SIZE.h + 2) * scale;

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
    <div className="vignette__holder" ref={holder}>
      <figure
        className={`vignette vignette--${advice?.kind ?? "unavailable"}${compact ? " vignette--compact" : ""}`}
        /*
         * The artwork's width is handed to CSS rather than set here.
         *
         * It used to be `width: width` on this element, which pinned the whole figure — picture
         * and caption together — to the scene, so the caption wrapped to the picture's column the
         * way a newspaper photograph's does. That is right when the two are stacked and wrong
         * once there is room to put them side by side: an inline width cannot be widened by a
         * media query, so the stop page's weather section stayed 528 pixels wide inside a
         * 1148-pixel column with the rest of it empty. The stylesheet now decides, and this only
         * says how wide the picture is.
         */
        style={{ "--scene-w": width } as CSSProperties}
        data-condition={kind ?? "unavailable"}
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

          {(advice ? EFFECTS_FOR[advice.kind] : []).map((panelName, index) => {
            /*
             * Each composition has its own effect layers, because a layer is laid over its scene
             * pixel for pixel. A 176-wide sheet of rain over the 320-wide world would either
             * stretch — the one thing this art system exists to avoid — or leave two fifths of
             * the street dry.
             */
            const name = world ? (`${panelName}World` as keyof typeof ART) : panelName;
            const art = ART[name] ?? ART[panelName]!;
            const isSun = panelName === "effect_sun";
            return (
              <img
                key={name}
                className={`vignette__effect vignette__effect--${panelName.replace("effect_", "")}`}
                src={art.src}
                width={art.w * scale}
                height={art.h * scale}
                // The sun sits top-left; every other effect covers the whole scene.
                style={
                  isSun
                    ? { left: 4 * scale, top: 2 * scale }
                    : { left: 0, top: 0, animationDelay: `${index * -0.7}s` }
                }
                alt=""
              />
            );
          })}

          {busApproaching ? (
            <img
              className="vignette__bus"
              src={(hour?.isDay !== false ? ART.farBusDay! : ART.farBusNight!).src}
              width={(hour?.isDay !== false ? ART.farBusDay! : ART.farBusNight!).w * scale}
              height={(hour?.isDay !== false ? ART.farBusDay! : ART.farBusNight!).h * scale}
              /*
               * On the road, coming towards the stop.
               *
               * Measured from this composition's own height rather than from the panel's, or the
               * bus in the world scene sat twenty-four pixels below the tarmac.
               */
              style={{ left: (world ? 168 : 6) * scale, top: (size.h - 26) * scale }}
              alt=""
            />
          ) : null}

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
          {hour === null ? (
            /*
             * Said plainly, with no reading invented to fill the space. The collector publishes by
             * degree square, so a stop it has not reached yet is a coverage gap rather than a
             * failure, and either way the honest thing is a sentence rather than a guess.
             */
            <p className="vignette__unavailable">Weather temporarily unavailable</p>
          ) : (
            <p className="vignette__reading">
              <strong>{Math.round(hour.temperatureCelsius)}°C</strong>
              <span className="muted">
                feels like {Math.round(hour.apparentTemperatureCelsius)}°C
              </span>
              <span>{condition}</span>
            </p>
          )}

          {advice?.message ? (
            <p className="vignette__advice">
              {advice.message}
              {advice.because.length > 0 ? (
                <span className="vignette__because muted small"> {advice.because.join(" · ")}</span>
              ) : null}
            </p>
          ) : null}

          {/* Every published number, so the picture is never the only thing said. */}
          {hour === null ? null : (
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
              {compact ? null : (
                <>
                  <div>
                    <dt>UV</dt>
                    <dd>{hour.uvIndex === null ? "Not published" : hour.uvIndex.toFixed(1)}</dd>
                  </div>
                  <div>
                    <dt>Daylight</dt>
                    <dd>{hour.isDay ? "Daytime" : "After dark"}</dd>
                  </div>
                </>
              )}
            </dl>
          )}

          {/*
            The attribution is not optional in either form. Open-Meteo's licence requires it, and
            a compact panel is a smaller place to say it, not a reason not to.
          */}
          {weather === null ? (
            /*
             * No attribution, because nothing has been attributed: Open-Meteo's licence applies to
             * a reading and there is no reading. Where the gap comes from is worth saying instead.
             */
            <p className="vignette__source small muted">
              The forecast collector has not published this stop&apos;s area yet.
            </p>
          ) : compact ? (
            <p className="vignette__source micro muted">{weather.attribution}</p>
          ) : (
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
          )}
        </figcaption>
      </figure>
    </div>
  );
}
