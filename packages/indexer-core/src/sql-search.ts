import { buildPathPrefixesSql } from "./sql-path-prefix.js";

/** The path filter and `LIMIT` placeholder of one search statement, from {@link buildSearchFilterSql}. */
export interface SearchFilterSql {
  /** The path-prefix condition (an OR of prefixes), or `undefined` when no paths constrain the search. */
  pathCondition: string | undefined;
  /** The placeholder (e.g. `$4`) bound to `topK`, for the statement's `LIMIT`. */
  topKParam: string;
  /** Every bind value in order: the leading params, the path params, then `topK`. */
  params: unknown[];
}

/**
 * Assemble the shared tail of a SQL search: the leading bind values (e.g. the query text or
 * vector, as `$1`...), a path-prefix condition on `column` numbered after them, and `topK` as the
 * last bind value. Each dialect places `pathCondition` in its own statement (after `AND`, or as a
 * `WHERE`).
 */
export function buildSearchFilterSql(
  column: string,
  paths: readonly string[] | undefined,
  topK: number,
  leadingParams: readonly unknown[],
): SearchFilterSql {
  const params: unknown[] = [...leadingParams];
  let pathCondition: string | undefined;
  if (paths && paths.length > 0) {
    const cond = buildPathPrefixesSql(column, [...paths], params.length + 1);
    pathCondition = cond.sql;
    params.push(...cond.params);
  }
  const topKParam = `$${params.length + 1}`;
  params.push(topK);
  return { pathCondition, topKParam, params };
}

/**
 * Format an embedding as a SQL array literal (`[0.1,0.2,...]`), locale-independent via
 * `Number.prototype.toString`. DuckDB (`::FLOAT[dim]`) and pgvector (`::vector(dim)`) both parse it
 * back with a cast on the bind placeholder.
 */
export function embeddingToLiteral(embedding: Float32Array): string {
  return `[${Array.from(embedding).join(",")}]`;
}

/**
 * ISO-639-1 codes accepted as `FullTextIndexInfo.language` by the SQL backends, mapped to the
 * lowercase English language name. The names are both the Snowball stemmer names (DuckDB's `fts`
 * extension) and the PostgreSQL text-search configuration names (PGlite).
 */
export const ISO_639_1_LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: "english",
  fr: "french",
  de: "german",
  es: "spanish",
  it: "italian",
  pt: "portuguese",
  nl: "dutch",
  ru: "russian",
  sv: "swedish",
  no: "norwegian",
  da: "danish",
  fi: "finnish",
  hu: "hungarian",
  ro: "romanian",
  tr: "turkish",
};
