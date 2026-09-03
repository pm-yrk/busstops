import { PixelBusFront } from "./pixel/PixelArt.js";
import "./Wordmark.css";

/**
 * The Bus Stops. wordmark (docs/02_DESIGN_SYSTEM.md "Brand").
 *
 * The full stop is part of the name and is always red. At hero size it carries a tiny
 * front-facing pixel bus; below that it is a plain red full stop, because the bus stops being
 * legible before it stops being decorative. The name is never split into red/blue letters and
 * never uses unusual internal capitalisation.
 */

export interface WordmarkProps {
  variant?: "stacked" | "horizontal";
  size?: "hero" | "large" | "small";
  /** The wordmark is the site identity; only one instance per page should be the heading. */
  as?: "h1" | "div" | "span";
}

export function Wordmark({ variant = "horizontal", size = "small", as = "div" }: WordmarkProps) {
  const Tag = as;
  const showPixelBus = size === "hero";

  return (
    <Tag className={`wordmark wordmark--${variant} wordmark--${size}`}>
      <span className="visually-hidden">Bus Stops.</span>
      <span aria-hidden="true" className="wordmark__text">
        <span className="wordmark__line">Bus</span>
        <span className="wordmark__line">
          Stops
          {showPixelBus ? (
            <span className="wordmark__dot wordmark__dot--bus">
              <PixelBusFront size={size === "hero" ? 28 : 14} />
            </span>
          ) : (
            <span className="wordmark__dot">.</span>
          )}
        </span>
      </span>
    </Tag>
  );
}
