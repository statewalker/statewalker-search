import { describe, expect, it } from "vitest";
import { legacySanitizePrefix, sanitizePrefix } from "../src/sanitize-prefix.js";
import {
  legacySqlTableNaming,
  SQL_MAX_INDEX_PREFIX,
  SQL_MAX_SUB_INDEX_PREFIX,
  sqlDocsTableName,
  sqlFtsTableName,
  sqlTableNaming,
  sqlVectorIndexName,
  sqlVectorTableName,
} from "../src/sql-table-names.js";

// These names are a storage format: existing databases are opened by them. The expected strings
// are spelled out literally so any change to the scheme fails here.
describe("SQL table names", () => {
  it("names the per-Index docs table idx_<indexPrefix>_docs", () => {
    expect(sqlDocsTableName("docs")).toBe("idx_docs_docs");
    expect(sqlDocsTableName(sqlTableNaming.indexPrefix("my-index"))).toBe("idx_my_45_index_docs");
  });

  it("builds the sub-index prefix from the sanitized index and sub-index names", () => {
    expect(sqlTableNaming.subIndexPrefix("docs", "body")).toBe("docs_body");
    expect(sqlTableNaming.subIndexPrefix("my-index", "q.fr")).toBe("my_45_index_q_46_fr");
  });

  it("names the full-text, vector and HNSW objects of a sub-index", () => {
    const sp = sqlTableNaming.subIndexPrefix("docs", "body");
    expect(sqlFtsTableName(sp)).toBe("idx_docs_body_fts");
    expect(sqlVectorTableName(sp)).toBe("idx_docs_body_vec");
    expect(sqlVectorIndexName(sp)).toBe("idx_docs_body_vec_hnsw");
  });

  it("escapes upper-case letters, so names differing only in case get different tables", () => {
    expect(sanitizePrefix("Notes")).toBe("_78_otes");
    expect(sqlTableNaming.indexPrefix("Notes")).not.toBe(sqlTableNaming.indexPrefix("notes"));
    expect(sqlTableNaming.subIndexPrefix("n", "Q")).not.toBe(
      sqlTableNaming.subIndexPrefix("n", "q"),
    );
  });

  it("keeps the names of lower-case, short names unchanged from earlier versions", () => {
    for (const [index, sub] of [
      ["docs", "body"],
      ["my-index", "q.fr"],
      ["proj/a", "en body"],
    ] as const) {
      expect(sqlTableNaming.indexPrefix(index)).toBe(legacySqlTableNaming.indexPrefix(index));
      expect(sqlTableNaming.subIndexPrefix(index, sub)).toBe(
        legacySqlTableNaming.subIndexPrefix(index, sub),
      );
    }
  });

  it("bounds long prefixes with a hash of the full names, so every identifier fits 63 bytes", () => {
    const longIndex = "projects/acme/workspace/documents/knowledge-base/alpha";
    const p = sqlTableNaming.indexPrefix(longIndex);
    expect(p.length).toBe(SQL_MAX_INDEX_PREFIX);
    expect(`${sqlDocsTableName(p)}_seq`.length).toBeLessThanOrEqual(63);
    expect(p).toMatch(/^[a-z0-9_]+$/);
    expect(sqlTableNaming.indexPrefix(`${longIndex}2`)).not.toBe(p);

    const a = sqlTableNaming.subIndexPrefix("kb", "body-english-stemmed-paragraph-level-chunks-v1");
    const b = sqlTableNaming.subIndexPrefix("kb", "body-english-stemmed-paragraph-level-chunks-v2");
    expect(a).not.toBe(b);
    expect(a.length).toBe(SQL_MAX_SUB_INDEX_PREFIX);
    expect(`${sqlFtsTableName(a)}_tsv_idx`.length).toBeLessThanOrEqual(63);
    expect(sqlVectorIndexName(a).length).toBeLessThanOrEqual(63);
    expect(sqlTableNaming.subIndexPrefix(longIndex, "q").length).toBe(SQL_MAX_SUB_INDEX_PREFIX);
    // The same names always give the same prefix.
    expect(
      sqlTableNaming.subIndexPrefix("kb", "body-english-stemmed-paragraph-level-chunks-v1"),
    ).toBe(a);
  });

  it("spells out the earlier versions' scheme: upper case kept, no length bound", () => {
    expect(legacySanitizePrefix("Notes")).toBe("Notes");
    expect(legacySqlTableNaming.indexPrefix("My-Index")).toBe("My_45_Index");
    expect(legacySqlTableNaming.subIndexPrefix("My-Index", "Q")).toBe("My_45_Index_Q");
    const long = "x".repeat(80);
    expect(legacySqlTableNaming.indexPrefix(long)).toBe(long);
  });
});
