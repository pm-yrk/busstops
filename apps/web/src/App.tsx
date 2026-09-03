import { Suspense, lazy } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { Wordmark } from "./components/Wordmark.js";
import { LoadingBus } from "./components/LoadingBus.js";
import { HomePage } from "./pages/HomePage.js";
import { StopPage } from "./pages/StopPage.js";
import { VehiclePage } from "./pages/VehiclePage.js";
import { RoutePage } from "./pages/RoutePage.js";
import { OperatorPage } from "./pages/OperatorPage.js";
import { DisruptionsPage } from "./pages/DisruptionsPage.js";
import { JourneyPage } from "./pages/JourneyPage.js";
import { UnsubscribePage } from "./pages/UnsubscribePage.js";
import { ProLayout } from "./pro/ProLayout.js";
import { ControlTowerPage } from "./pro/ControlTowerPage.js";
import { LiveOperationsPage } from "./pro/LiveOperationsPage.js";
import { RoutesPage } from "./pro/RoutesPage.js";
import { OperatorsPage } from "./pro/OperatorsPage.js";
import { CongestionPage } from "./pro/CongestionPage.js";
import { AnalyticsPage } from "./pro/AnalyticsPage.js";
import { ReportsPage } from "./pro/ReportsPage.js";
import { DailyBriefPage } from "./pro/DailyBriefPage.js";
import { ProSettingsPage } from "./pro/ProSettingsPage.js";
import { SearchPage } from "./pages/SearchPage.js";
import { SavedPage } from "./pages/SavedPage.js";
import { MethodologyPage } from "./pages/MethodologyPage.js";
import { LegalPages } from "./pages/LegalPages.js";
import { NotFoundPage } from "./pages/NotFoundPage.js";
import "./App.css";

/**
 * Application shell.
 *
 * The map surfaces are lazily loaded because MapLibre is by far the largest dependency and the
 * home, stop and saved surfaces must stay usable on a slow connection without it.
 */

const LiveMapPage = lazy(() =>
  import("./pages/LiveMapPage.js").then((m) => ({ default: m.LiveMapPage })),
);

export function App() {
  const location = useLocation();
  // The live map manages its own full-height layout; other pages use the standard shell.
  const isMapSurface = location.pathname.startsWith("/live");

  return (
    <div className={`app ${isMapSurface ? "app--map" : ""}`}>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      <header className="app__header no-print">
        <div className="app__header-inner">
          <Link to="/" className="app__brand" aria-label="Bus Stops. home">
            <Wordmark variant="horizontal" size="small" />
          </Link>

          <nav className="app__nav" aria-label="Primary">
            <NavLink to="/live" className="app__nav-link">
              Live map
            </NavLink>
            <NavLink to="/journey" className="app__nav-link">
              Journey
            </NavLink>
            <NavLink to="/disruptions" className="app__nav-link">
              Disruptions
            </NavLink>
            <NavLink to="/pro" className="app__nav-link">
              Pro
            </NavLink>
            <NavLink to="/search" className="app__nav-link">
              Search
            </NavLink>
            <NavLink to="/saved" className="app__nav-link">
              Saved
            </NavLink>
          </nav>
        </div>
      </header>

      <main id="main" className="app__main" tabIndex={-1}>
        <Suspense fallback={<LoadingBus label="Loading the map" />}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/live" element={<LiveMapPage />} />
            <Route path="/live/stops/:stopId" element={<LiveMapPage />} />
            <Route path="/stops/:stopId" element={<StopPage />} />
            <Route path="/vehicles/:vehicleRef" element={<VehiclePage />} />
            <Route path="/routes/:routeId" element={<RoutePage />} />
            <Route path="/operators/:operatorId" element={<OperatorPage />} />
            <Route path="/disruptions" element={<DisruptionsPage />} />
            <Route path="/journey" element={<JourneyPage />} />
            <Route path="/unsubscribe" element={<UnsubscribePage />} />
            <Route path="/pro" element={<ProLayout />}>
              <Route index element={<ControlTowerPage />} />
              <Route path="live" element={<LiveOperationsPage />} />
              <Route path="routes" element={<RoutesPage />} />
              <Route path="operators" element={<OperatorsPage />} />
              <Route path="congestion" element={<CongestionPage />} />
              <Route path="analytics" element={<AnalyticsPage />} />
              <Route path="reports" element={<ReportsPage />} />
              <Route path="brief" element={<DailyBriefPage />} />
              <Route path="settings" element={<ProSettingsPage />} />
            </Route>
            <Route path="/search" element={<SearchPage />} />
            <Route path="/saved" element={<SavedPage />} />
            <Route path="/methodology" element={<MethodologyPage />} />
            <Route path="/about" element={<LegalPages page="about" />} />
            <Route path="/privacy" element={<LegalPages page="privacy" />} />
            <Route path="/terms" element={<LegalPages page="terms" />} />
            <Route path="/contact" element={<LegalPages page="contact" />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </main>

      <footer className="app__footer no-print">
        <div className="app__footer-inner">
          <nav aria-label="Secondary">
            <Link to="/methodology">Data &amp; methodology</Link>
            <Link to="/about">About</Link>
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
            <Link to="/contact">Contact</Link>
          </nav>
          <p className="app__attribution micro muted">
            Contains public sector information licensed under the Open Government Licence v3.0.
            Powered by TfL Open Data. © OpenStreetMap contributors, ODbL. Weather data by
            Open-Meteo.com.
          </p>
        </div>
      </footer>
    </div>
  );
}
