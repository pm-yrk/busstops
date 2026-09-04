import { NavLink, Outlet } from "react-router-dom";
import { PixelRouteMark } from "../components/pixel/PixelArt.js";
import "./ProLayout.css";

/**
 * The Pro shell.
 *
 * There is no sign-in anywhere in this layout, and that is deliberate. Authentication in this
 * product gates private preferences, organisations, recipients and email delivery — never the
 * ability to see what the bus network is doing. A transport officer, a councillor or a passenger
 * should all be able to open this and check the figures.
 */

const SECTIONS = [
  { to: "/pro", label: "Control Tower", end: true },
  { to: "/pro/live", label: "Live Operations" },
  { to: "/pro/routes", label: "Routes" },
  { to: "/pro/operators", label: "Operators" },
  { to: "/pro/congestion", label: "Congestion" },
  { to: "/pro/analytics", label: "Analytics" },
  { to: "/pro/disruptions", label: "Disruptions" },
  { to: "/pro/reports", label: "Reports" },
  { to: "/pro/brief", label: "Daily Brief" },
  { to: "/pro/settings", label: "Settings" },
];

export function ProLayout() {
  return (
    <div className="page pro-layout">
      <header className="pro-layout__header">
        <div className="pro-layout__title">
          {/*
           * One pixel detail, deliberately small. Pro is a working tool and should feel calmer
           * than Live, but it is the same product — and a page with none of the family's drawing
           * anywhere on it stops looking like it belongs.
           */}
          <PixelRouteMark size={26} className="pro-layout__mark" />
          <div>
            <p className="pro-layout__eyebrow">Bus Stops</p>
            <h1>Pro</h1>
          </div>
        </div>
        <p className="pro-layout__intro">
          Public, read-only, and open without an account. Every figure states how it was measured,
          how much it rests on, and how much of the network it can actually see.
        </p>
      </header>

      <nav className="pro-layout__nav" aria-label="Pro sections">
        {SECTIONS.map((section) => (
          <NavLink
            key={section.to}
            to={section.to}
            end={section.end ?? false}
            className={({ isActive }) =>
              isActive ? "pro-layout__link is-active" : "pro-layout__link"
            }
          >
            {section.label}
          </NavLink>
        ))}
      </nav>

      <main className="pro-layout__main">
        <Outlet />
      </main>
    </div>
  );
}
