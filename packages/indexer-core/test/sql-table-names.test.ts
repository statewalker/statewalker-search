import { describe, expect, it } from "vitest";
import { sanitizePrefix } from "../src/sanitize-prefix.js";
import {
  sqlDocsTableName,
  sqlFtsTableName,
  sqlSubIndexPrefix,
  sqlVectorIndexName,
  sqlVectorTableName,
} from "../src/sql-table-names.js";

// These names are a storage format: existing databases are opened by them. The expected strings
// are spelled out literally so any change to the scheme fails here.
describe("SQL table names", () => {
  it("names the per-Index docs table idx_<indexPrefix>_docs", () => {
    expect(sqlDocsTableName("docs")).toBe("idx_docs_docs");
    expect(sqlDocsTableName(sanitizePrefix("my-index"))).toBe("idx_my_45_index_docs");
  });

  it("builds the sub-index prefix from the index prefix and the sanitized sub-index name", () => {
    expect(sqlSubIndexPrefix("docs", "body")).toBe("docs_body");
    expect(sqlSubIndexPrefix("my_45_index", "q.fr")).toBe("my_45_index_q_46_fr");
  });

  it("names the full-text, vector and HNSW objects of a sub-index", () => {
    const sp = sqlSubIndexPrefix("docs", "body");
    expect(sqlFtsTableName(sp)).toBe("idx_docs_body_fts");
    expect(sqlVectorTableName(sp)).toBe("idx_docs_body_vec");
    expect(sqlVectorIndexName(sp)).toBe("idx_docs_body_vec_hnsw");
  });
});
