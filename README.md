# Bus Stops.

**Live bus information for passengers, with a second operational view for the people running the network.**

[**Open the live preview →**](https://preview.busstops.pages.dev)

<img width="1440" height="900" alt="BusStops_Home" src="https://github.com/user-attachments/assets/07fadc9b-feb2-43e5-9853-29e95573e5e0" />

## Why I built it

I work in transport, so I wanted to build something around a problem I actually understand rather than make another generic dashboard.

There is loads of public transport data available, but that does not automatically make it useful. A passenger usually just wants a straight answer to things like **where is my bus, will I make it, and what should I do if it has stopped or disappeared?** On the operations side, the same data needs turning into something that helps people see what is happening across a network without pretending the data is better than it really is.

That became **Bus Stops Live** for passengers and **Bus Stops Pro** for the operational side.

## What it does

### Bus Stops Live

- Live map and stop arrival boards.
- Keeps live predictions separate from timetable-only departures.
- Journey planning using a realistic time range instead of false precision.
- **Will I make it?** for a quick connection check.
- **Bus Stopped?** for practical next steps when a passenger seems stuck waiting.
- Nearby alternatives and disruption information where the data supports it.
- Clear hand-offs to official ticket buying options where available.
- Favourites and location data kept locally on the passenger's device.

### Bus Stops Pro

A public, read-only demonstration of the operational side of the product, including Control Tower, Live Operations, Routes, Operators, Congestion, Analytics, Disruptions, Reports and a Daily Brief.

<img width="1440" height="900" alt="BusStops_Pro" src="https://github.com/user-attachments/assets/bae6c588-37fa-4d98-b93e-8da9d585e32f" />

The aim is not to throw as many numbers as possible onto a screen. The useful bit is knowing **what the number is based on, how fresh it is and whether there is enough coverage to trust it**.

## What I was responsible for

I came up with the product and decided what I wanted it to do from a transport and passenger point of view. I have defined and refined the requirements, the operational rules, what should and should not be shown, how uncertainty should be handled and how the different parts of the product should work together.

I also test the outputs against real scenarios and data. If a figure does not make sense, a journey result feels wrong, live data is being presented too confidently or a screen is not useful in the real world, I go back through it and change the requirements or implementation until it behaves the way I intended.

### How I use AI

I use AI heavily as a development tool and implementation accelerator. I am not presenting this as me manually typing every line of code.

The part I own is the **problem definition, product logic, transport rules, requirements, validation, QA and the decisions behind the product**. AI helps me turn those decisions into a working system much faster, but I do not treat generated code or generated answers as automatically correct. A lot of the work on this project has been finding where an implementation technically works but does not give the right real-world answer, then working through it until it does.

That is also the reason the repository keeps the AI-assisted development history visible rather than trying to hide it.

## A few rules I cared about

- **Do not make data up.** If something cannot be measured, say that rather than fill the gap with a convincing-looking number.
- **Show the context behind a metric.** Denominator, time window, freshness, coverage and confidence matter just as much as the headline percentage.
- **Suppress weak figures rather than mislead.** No data and zero are not the same thing.
- **Do not turn correlation into causation.** A roadworks event near a delay can be useful context without claiming it caused the delay.
- **Make uncertainty understandable.** Journey times are ranges where that is more truthful than pretending to know the exact minute.
- **Privacy by design.** Passenger favourites and location stay on-device, and vehicle references are deliberately made difficult to join across days.
- **Keep running costs under control.** The product has its own free-tier governor and a defined degradation order before paid limits could be reached.

## Under the bonnet

The project is deliberately bigger than the interface. It includes the passenger app, the operational view, an edge API, data adapters, analytics, journey planning, vehicle matching, scheduled pipelines, automated testing and deployment.

**Main tools:** React, TypeScript, Vite, Cloudflare Workers / Pages / R2, public transport APIs and open data, Zod, Playwright, GitHub Actions and AI-assisted development.

```text
apps/web                Bus Stops Live + Bus Stops Pro
apps/worker             Cloudflare edge API
packages/contracts      Shared typed data contracts
packages/adapters       BODS, TfL, NaPTAN and other public data sources
packages/analytics      Operational metrics, baselines and confidence
packages/journey        Journey planning
packages/matching       Vehicle and journey matching
packages/governor       Free-tier budget controls and safe degradation
packages/daily-brief    Frozen daily operational snapshot
pipelines/              Scheduled collection and processing
```

<details>
<summary><strong>More technical detail</strong></summary>

The codebase enforces a few things quite aggressively: production data paths do not fall back to invented data; low-confidence metrics can publish as unavailable rather than as a placeholder; road events are treated as corroborating context rather than proof of cause; raw vehicle positions are deliberately short-lived; and the budget governor degrades features in a documented order before cost thresholds are reached.

The project includes unit, contract, integration, property, browser and accessibility testing. A deployment preview provisions the Cloudflare resources, deploys the Worker and Pages build, bootstraps real network data, smoke-tests the result and runs a visual QA pass.

For deeper implementation notes, see [`docs/`](docs/), the threat model, ADRs and runbooks.

</details>

## Running it locally

```bash
npm install
npm run dev --workspace @busstops/web
```

No credentials are needed to build, typecheck, lint or run the main test suites against fixtures.

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run preflight
node scripts/secret-scan.mjs
```

## Data sources and attribution

Contains public sector information licensed under the Open Government Licence v3.0. Bus location and timetable data comes from the Bus Open Data Service and Transport for London. Stop data comes from NaPTAN. Map data © OpenStreetMap contributors, ODbL. Weather data comes from Open-Meteo, with additional public data from the Environment Agency, National Highways and Street Manager.
