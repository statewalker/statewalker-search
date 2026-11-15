import { runMemFullTextStateSuite } from "@statewalker/indexer-tests";
import { MiniSearchFullTextIndex } from "../src/minisearch-full-text-index.js";

runMemFullTextStateSuite("MiniSearchFullTextIndex", {
  create: () => new MiniSearchFullTextIndex({ language: "en" }),
});
