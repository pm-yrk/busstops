/**
 * Minimal RFC 4180 CSV reader. NaPTAN rows contain quoted commas and embedded quotes in
 * stop names ("The Bull", "St John's, Church"), so a naive split() corrupts real data.
 */

export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/** Splits CSV text into logical rows, respecting newlines inside quoted fields. */
export function splitCsvRows(text: string): string[] {
  const rows: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      inQuotes = !inQuotes || text[i + 1] === '"';
      if (inQuotes && text[i + 1] === '"') i += 1;
      current += char;
      continue;
    }
    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      if (current.length > 0) rows.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

/** Parses CSV text into header-keyed records. Rows with the wrong field count are skipped. */
export function parseCsv(text: string): Record<string, string>[] {
  // NaPTAN exports are UTF-8 with a BOM, which would otherwise corrupt the first header name.
  const rows = splitCsvRows(text.replace(/^\uFEFF/, ""));
  if (rows.length === 0) return [];

  const headers = parseCsvLine(rows[0]!).map((h) => h.trim());
  const records: Record<string, string>[] = [];

  for (let i = 1; i < rows.length; i++) {
    const values = parseCsvLine(rows[i]!);
    if (values.length !== headers.length) continue;
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = values[index] ?? "";
    });
    records.push(record);
  }
  return records;
}
