import { Link } from "react-router-dom";
import { PixelStopPole } from "../components/pixel/PixelArt.js";

/** Invalid deep link: an explicit state, with a way forward rather than a dead end. */
export function NotFoundPage() {
  return (
    <div className="page">
      <PixelStopPole scale={2} />
      <h1>That page does not exist</h1>
      <p className="muted" style={{ maxWidth: "60ch" }}>
        The link may be out of date, or the stop or route may have been withdrawn. Searching by name
        or stop code is the quickest way back.
      </p>
      <div style={{ display: "flex", gap: "var(--space-sm)", flexWrap: "wrap" }}>
        <Link
          to="/search"
          className="button-primary"
          style={{
            display: "inline-flex",
            alignItems: "center",
            minHeight: "var(--min-touch-target)",
            padding: "0 var(--space-md)",
            borderRadius: "var(--radius-md)",
            textDecoration: "none",
          }}
        >
          Search
        </Link>
        <Link
          to="/live"
          style={{
            display: "inline-flex",
            alignItems: "center",
            minHeight: "var(--min-touch-target)",
          }}
        >
          Open the live map
        </Link>
      </div>
    </div>
  );
}
