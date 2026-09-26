import type { ReactNode } from "react";
import {
  PixelBusMark,
  PixelChart,
  PixelClock,
  PixelCloud,
  PixelCone,
  PixelPersonMark,
  PixelPin,
  PixelRouteMark,
  PixelStopMark,
  PixelWarning,
} from "./PixelArt.js";
import "./PixelSectionHeading.css";

/**
 * A section heading with a mark beside it and a run of pixels after it.
 *
 * Every page below the home page was a column of bare `h2`s on white, which is why they read as a
 * spreadsheet with headings rather than as a designed page. This is the smallest change that fixes
 * that everywhere at once: the same sixteen-unit marks the rest of the interface already uses, and
 * a rule made of squares rather than a hairline, so the divider is drawn in the same idiom as the
 * artwork instead of in the idiom of a form.
 *
 * The mark is decorative — `PixelArt` hides an untitled sprite from screen readers — because the
 * heading text already says what the section is. A picture of a clock next to the word "Live" is
 * for the eye finding its place down a page, not for anybody being told about it twice.
 */

const MARKS = {
  clock: PixelClock,
  bus: PixelBusMark,
  stop: PixelStopMark,
  person: PixelPersonMark,
  weather: PixelCloud,
  warning: PixelWarning,
  works: PixelCone,
  route: PixelRouteMark,
  chart: PixelChart,
  place: PixelPin,
} as const;

export type SectionMark = keyof typeof MARKS;

/**
 * The same map, for anything that wants a mark without a heading around it.
 *
 * Pro's metric tiles need one beside a figure rather than above a section, and copying the list
 * would be two vocabularies that drift. Exported rather than duplicated.
 */
export const SECTION_MARKS = MARKS;

export interface PixelSectionHeadingProps {
  children: ReactNode;
  mark: SectionMark;
  /** The heading level. Defaults to `h2`, which is what a page section wants. */
  level?: 2 | 3;
  /** The `id` the section's `aria-labelledby` points at. */
  id?: string;
  /** Anything that belongs on the heading's line — a count, an age, a control. */
  aside?: ReactNode;
  className?: string;
}

export function PixelSectionHeading({
  children,
  mark,
  level = 2,
  id,
  aside,
  className,
}: PixelSectionHeadingProps) {
  const Mark = MARKS[mark];
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className={className ? `pixel-heading ${className}` : "pixel-heading"}>
      {/*
       * The mark is sized in whole art pixels: a 16-unit canvas at 20px would be a unit and a
       * quarter per square, which is the one thing the whole art system is careful not to do.
       */}
      <Mark size={24} className="pixel-heading__mark" />
      <Heading className="pixel-heading__text" {...(id === undefined ? {} : { id })}>
        {children}
      </Heading>
      {/* A run of squares out to the end of the line, so the heading sits on something. */}
      <span className="pixel-heading__rule" aria-hidden="true" />
      {aside ? <div className="pixel-heading__aside">{aside}</div> : null}
    </div>
  );
}
