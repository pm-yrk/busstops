import { useState } from "react";
import { Link } from "react-router-dom";
import "./ProLayout.css";

/**
 * Pro settings (docs/10_BUS_STOPS_PRO.md "Settings").
 *
 * In the public demo these are ephemeral and local: nothing is sent anywhere, nothing is stored
 * against a person, and there is no account to attach them to. Saying so plainly matters, because
 * a settings page that quietly persisted a viewer's choices to a server would be collecting data
 * from someone who never agreed to anything.
 *
 * Organisation scope, recipients and Daily Brief delivery need an account and are shown here as
 * what they are — unavailable in the public demo — rather than hidden.
 */

const STORAGE_KEY = "busstops.pro.display";

interface DisplayPreferences {
  timezone: string;
  metricProfile: "standard" | "strict";
  denseTables: boolean;
}

const DEFAULTS: DisplayPreferences = {
  timezone: "Europe/London",
  metricProfile: "standard",
  denseTables: false,
};

function readPreferences(): DisplayPreferences {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<DisplayPreferences>) };
  } catch {
    // Storage can be unavailable or blocked; defaults are a correct answer, not an error.
    return DEFAULTS;
  }
}

export function ProSettingsPage() {
  const [preferences, setPreferences] = useState<DisplayPreferences>(readPreferences);
  const [saved, setSaved] = useState(false);
  const [storageBlocked, setStorageBlocked] = useState(false);

  const update = (patch: Partial<DisplayPreferences>) => {
    const next = { ...preferences, ...patch };
    setPreferences(next);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
      setSaved(true);
      setStorageBlocked(false);
    } catch {
      setStorageBlocked(true);
    }
  };

  return (
    <>
      <section className="pro-section" aria-labelledby="settings-display">
        <h2 id="settings-display">Display</h2>
        <p className="muted small">
          These preferences are kept in this browser only. Nothing is sent to a server and nothing
          is stored against you.
        </p>

        <div className="pro-filters">
          <label>
            <span>Timezone</span>
            <select
              value={preferences.timezone}
              onChange={(event) => update({ timezone: event.target.value })}
            >
              <option value="Europe/London">Europe/London</option>
              <option value="UTC">UTC</option>
            </select>
          </label>

          <label>
            <span>Metric definitions</span>
            <select
              value={preferences.metricProfile}
              onChange={(event) =>
                update({ metricProfile: event.target.value as DisplayPreferences["metricProfile"] })
              }
            >
              <option value="standard">Standard (1 min early to 5 min late)</option>
              <option value="strict">Strict (on time to 3 min late)</option>
            </select>
          </label>

          <label>
            <span>Table density</span>
            <select
              value={preferences.denseTables ? "dense" : "comfortable"}
              onChange={(event) => update({ denseTables: event.target.value === "dense" })}
            >
              <option value="comfortable">Comfortable</option>
              <option value="dense">Dense</option>
            </select>
          </label>
        </div>

        {storageBlocked ? (
          <p className="pro-note">
            This browser is blocking local storage, so these preferences will reset when you leave.
            Everything else on Pro works normally.
          </p>
        ) : saved ? (
          <p className="muted small" role="status">
            Saved in this browser.
          </p>
        ) : null}
      </section>

      <section className="pro-section" aria-labelledby="settings-account">
        <h2 id="settings-account">Organisation and delivery</h2>
        <p>
          Organisation scope, permitted data scope, recipient lists and Daily Brief delivery need an
          account, because they involve sending email to named people. They are not part of the
          public demo.
        </p>
        <p className="muted small">
          Everything you can see on Pro is public and needs no sign-in. Signing in adds private
          preferences and email delivery; it does not unlock any additional analysis.{" "}
          <Link to="/privacy">How we handle personal data</Link>.
        </p>
      </section>

      <section className="pro-section" aria-labelledby="settings-methodology">
        <h2 id="settings-methodology">Definitions</h2>
        <p className="muted small">
          Every metric on Pro states its own definition in place. The full methodology, including
          how baselines and confidence are built, is on the{" "}
          <Link to="/methodology">methodology page</Link>.
        </p>
      </section>
    </>
  );
}
