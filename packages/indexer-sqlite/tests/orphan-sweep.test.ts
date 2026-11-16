// The shared orphan-sweep scenario (statewalker-search#90). SQLite shares the SQL kernel but
// never reclaims block ids, so it has no sweep: the scenario holds without a docs-table record.
import { runSqlOrphanSweepSuite } from "@statewalker/indexer-tests";
import {
  createSqliteIndexer,
  newSqliteFullTextProvider,
  newSqliteNgramProvider,
} from "../src/index.js";
import { flavours } from "./support/dbs.js";

for (const flavour of flavours) {
  runSqlOrphanSweepSuite(`SQLite (${flavour.name})`, {
    newDb: () => flavour.open(),
    closeDb: async (db) => {
      await db.close?.();
    },
    createIndexer: (db, { ngram }) =>
      createSqliteIndexer({
        db,
        providers: [newSqliteFullTextProvider(), ...(ngram ? [newSqliteNgramProvider()] : [])],
      }),
    query: (db, sql) => db.query(sql),
    recordsDocTables: false,
  });
}
