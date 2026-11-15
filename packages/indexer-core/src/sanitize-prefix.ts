/**
 * Make a name SQL-identifier-safe: every character outside `[a-z0-9]` becomes `_<charCode>_`.
 * Upper-case letters are escaped too, because Postgres and DuckDB fold unquoted identifiers to
 * lower case: `Notes` and `notes` must not name the same table.
 */
export function sanitizePrefix(name: string): string {
  return name.replace(/[^a-z0-9]/g, (ch) => `_${ch.charCodeAt(0)}_`);
}

/**
 * The scheme of earlier versions, which kept upper-case letters (`[^a-zA-Z0-9]` escaped). Used
 * only to find tables those versions created.
 */
export function legacySanitizePrefix(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, (ch) => `_${ch.charCodeAt(0)}_`);
}
