/**
 * Typed navigation over parsed XML.
 *
 * fast-xml-parser returns an untyped tree whose shape varies with the document: a repeated
 * element is an array, a single one is an object, and a text-only element is a string. These
 * helpers make that shape explicit at each access instead of spreading `any` through the
 * adapters, so a structural surprise in an upstream feed surfaces as `undefined` rather than a
 * runtime crash deep in a national ingest.
 */

export type XmlValue = string | number | boolean | null | undefined | XmlNode | XmlValue[];
export interface XmlNode {
  [key: string]: XmlValue;
}

export function isXmlNode(value: XmlValue): value is XmlNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a child by name, or undefined when the parent is not a node. */
export function child(value: XmlValue, key: string): XmlValue {
  return isXmlNode(value) ? value[key] : undefined;
}

/** Follows a path of child names. */
export function dig(value: XmlValue, ...path: string[]): XmlValue {
  let current = value;
  for (const key of path) {
    current = child(current, key);
    if (current === undefined) return undefined;
  }
  return current;
}

/** Normalizes "one or many" into an array, which is how repeated XML elements arrive. */
export function many(value: XmlValue): XmlValue[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Reads element text, handling the `#text` form used when an element also has attributes. */
export function text(value: XmlValue): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (isXmlNode(value)) {
    const inner = value["#text"];
    return inner === undefined ? undefined : String(inner).trim() || undefined;
  }
  if (Array.isArray(value)) return text(value[0]);
  const asText = String(value).trim();
  return asText.length === 0 ? undefined : asText;
}

/** Reads an attribute, given the parser's configured prefix. */
export function attribute(value: XmlValue, name: string): string | undefined {
  return text(child(value, `@_${name}`));
}

export function numberText(value: XmlValue): number | null {
  const raw = text(value);
  if (raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** True when a self-closing marker element such as `<Monday/>` is present. */
export function hasElement(value: XmlValue, key: string): boolean {
  return isXmlNode(value) && key in value;
}
