import { runMemFullTextStateSuite } from "@statewalker/indexer-tests";
import { FlexSearchFullTextIndex } from "../src/flexsearch-full-text-index.js";

runMemFullTextStateSuite("FlexSearchFullTextIndex", {
  create: () => new FlexSearchFullTextIndex({ language: "en" }),
});
