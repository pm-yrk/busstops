import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { StopWeather, StopWeatherHour } from "@busstops/contracts";
import { WeatherVignette } from "./WeatherVignette.js";

const now = new Date("2026-09-05T09:30:00.000Z");

function hour(overrides: Partial<StopWeatherHour> = {}): StopWeatherHour {
  return {
    time: "2026-09-05T09:00:00.000Z",
    temperatureCelsius: 14.2,
    apparentTemperatureCelsius: 13.1,
    precipitationMm: 0,
    precipitationProbability: 4,
    weatherCode: 1,
    windSpeedKph: 9,
    windGustKph: 15,
    uvIndex: 2.1,
    isDay: true,
    ...overrides,
  };
}

function weather(current: StopWeatherHour = hour()): StopWeather {
  return {
    cell: "537_-16",
    cellCentre: { lat: 53.75, lon: -1.55 },
    cellSizeDegrees: 0.1,
    current,
    next: [],
    retrievedAt: "2026-09-05T09:05:00.000Z",
    attribution: "Weather data by Open-Meteo.com (CC BY 4.0)",
  };
}

describe("WeatherVignette", () => {
  it("shows the published numbers beside the picture", () => {
    render(<WeatherVignette weather={weather()} atcoCode="450010001" now={now} />);

    expect(screen.getByText("14°C")).toBeInTheDocument();
    expect(screen.getByText(/feels like 13°C/)).toBeInTheDocument();
    expect(screen.getByText(/0\.0 mm/)).toBeInTheDocument();
    expect(screen.getByText(/9 km\/h/)).toBeInTheDocument();
    expect(screen.getByText("2.1")).toBeInTheDocument();
    expect(screen.getByText(/Open-Meteo/)).toBeInTheDocument();
  });

  it("says nothing when the weather needs no comment", () => {
    const { container } = render(
      <WeatherVignette weather={weather()} atcoCode="450010001" now={now} />,
    );
    expect(container.querySelector(".vignette__advice")).toBeNull();
  });

  it("puts an umbrella in the scene when it is raining, and says why", () => {
    render(
      <WeatherVignette
        weather={weather(
          hour({ precipitationMm: 2.4, precipitationProbability: 85, weatherCode: 63 }),
        )}
        atcoCode="450010001"
        now={now}
      />,
    );

    const figure = screen.getByRole("figure");
    expect(figure).toHaveClass("vignette--rain");
    expect(figure.querySelector(".vignette__accessory")).not.toBeNull();
    /*
     * The rainfall appears twice on purpose: once in the reason the message was chosen from, and
     * once in the list of every published number. A reader can disagree with the advice without
     * having to take the picture's word for it.
     */
    expect(screen.getAllByText(/2\.4 mm/)).toHaveLength(2);
    expect(screen.getByText(/85% chance of rain/)).toBeInTheDocument();
  });

  /*
   * Who is waiting is decided by the stop and the date and by nothing else. Tying the cast to the
   * weather would mean deciding which kinds of people go out in the rain.
   */
  it("chooses the same person whatever the sky is doing", () => {
    const clear = render(<WeatherVignette weather={weather()} atcoCode="450010001" now={now} />);
    const person = clear.getByRole("figure").dataset.person;
    clear.unmount();

    const snowing = render(
      <WeatherVignette
        weather={weather(
          hour({ weatherCode: 73, temperatureCelsius: -1, apparentTemperatureCelsius: -5 }),
        )}
        atcoCode="450010001"
        now={now}
      />,
    );
    expect(snowing.getByRole("figure").dataset.person).toBe(person);
  });

  it("gives different stops different people", () => {
    const first = render(<WeatherVignette weather={weather()} atcoCode="450010001" now={now} />);
    const people = new Set([first.getByRole("figure").dataset.person]);
    first.unmount();

    for (const atcoCode of ["450010002", "450010003", "1800SB12345", "490000173C"]) {
      const view = render(<WeatherVignette weather={weather()} atcoCode={atcoCode} now={now} />);
      people.add(view.getByRole("figure").dataset.person);
      view.unmount();
    }
    expect(people.size).toBeGreaterThan(1);
  });

  it("says a number is not published rather than showing a zero", () => {
    render(
      <WeatherVignette
        weather={weather(hour({ uvIndex: null, windGustKph: null }))}
        atcoCode="450010001"
        now={now}
      />,
    );
    expect(screen.getByText("Not published")).toBeInTheDocument();
    expect(screen.queryByText(/gusts/)).toBeNull();
  });

  it("draws the night scene after dark", () => {
    const { container } = render(
      <WeatherVignette weather={weather(hour({ isDay: false }))} atcoCode="450010001" now={now} />,
    );
    expect(screen.getByText("After dark")).toBeInTheDocument();
    expect(container.querySelector(".vignette__backdrop")).not.toBeNull();
  });

  it("scales every sprite by a whole number", () => {
    const { container } = render(
      <WeatherVignette weather={weather()} atcoCode="450010001" scale={3} now={now} />,
    );
    for (const image of container.querySelectorAll("img")) {
      const width = Number(image.getAttribute("width"));
      expect(Number.isInteger(width / 3)).toBe(true);
    }
  });
});
