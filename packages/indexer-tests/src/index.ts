// Conformance suites for the open-sub-index-registry contract.
//
// Backends import only the suites they need; each suite is self-contained and
// parameterised on the factories / Providers / hooks the backend can supply.

export type { FullTextSuiteOptions } from "./conformance/fulltext.suite.js";
export { runFullTextConformanceSuite } from "./conformance/fulltext.suite.js";
export type { FullTextMultiWordSuiteOptions } from "./conformance/fulltext-multiword.suite.js";
export { runFullTextMultiWordSuite } from "./conformance/fulltext-multiword.suite.js";

export type {
  KernelSuiteOptions,
  SubIndexConfig,
} from "./conformance/kernel.suite.js";
export {
  MemoryPersistence,
  runKernelConformanceSuite,
} from "./conformance/kernel.suite.js";
export type { LifecycleSuiteOptions } from "./conformance/lifecycle.suite.js";
export { runLifecycleConformanceSuite } from "./conformance/lifecycle.suite.js";
export type {
  ConfigFactory,
  FullTextModalityHooks,
  MultiInstanceSuiteOptions,
  VectorModalityHooks,
} from "./conformance/multi-instance.suite.js";
export { runMultiInstanceConformanceSuite } from "./conformance/multi-instance.suite.js";

export type { NgramSuiteOptions } from "./conformance/ngram.suite.js";
export { runNgramConformanceSuite } from "./conformance/ngram.suite.js";

export type { RrfSuiteOptions } from "./conformance/rrf-blending.suite.js";
export { runRrfBlendingSuite } from "./conformance/rrf-blending.suite.js";

export type { SqlNgramSuiteOptions } from "./conformance/sql-ngram.suite.js";
export { runSqlNgramSuite } from "./conformance/sql-ngram.suite.js";

export type { SqlTableNamesSuiteOptions } from "./conformance/sql-table-names.suite.js";
export { runSqlTableNamesSuite } from "./conformance/sql-table-names.suite.js";

export { collect, defined } from "./conformance/test-utils.js";

export type { IndexerFactory } from "./conformance/types.js";

export type { VectorSuiteOptions } from "./conformance/vector.suite.js";
export { runVectorConformanceSuite } from "./conformance/vector.suite.js";
