import "./Wordmark.css";

/**
 * The Bus Stops. wordmark (docs/02_DESIGN_SYSTEM.md "Brand").
 *
 * The full stop is part of the name and is always red — a clean full stop at every size. It used
 * to carry a tiny pixel bus at hero size; that reads as a smudge rather than a bus at the size the
 * punctuation wants to be, and it costs the mark its most recognisable feature. The pixel work
 * belongs in the scene beside the wordmark, where it has room to be drawn properly.
 *
 * The name is never split into red/blue letters and never uses unusual internal capitalisation.
 */

export interface WordmarkProps {
  variant?: "stacked" | "horizontal";
  size?: "hero" | "large" | "small";
  /** The wordmark is the site identity; only one instance per page should be the heading. */
  as?: "h1" | "div" | "span";
}

export function Wordmark({ variant = "horizontal", size = "small", as = "div" }: WordmarkProps) {
  const Tag = as;

  return (
    <Tag className={`wordmark wordmark--${variant} wordmark--${size}`}>
      <span className="visually-hidden">Bus Stops.</span>
      <span aria-hidden="true" className="wordmark__text">
        <span className="wordmark__line">Bus</span>
        <span className="wordmark__line">
          Stops
          <span className="wordmark__dot">.</span>
        </span>
      </span>
    </Tag>
  );
}
