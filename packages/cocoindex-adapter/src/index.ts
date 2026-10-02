/** Public surface of @semantic-context/cocoindex-adapter. */
export type {
  SemanticCandidate,
  SemanticSearchInput,
  SemanticCandidateProvider,
  AttestedSemanticSearchResult,
  DerivedProviderFactSeal,
} from "./provider";
export { NullSemanticCandidateProvider } from "./null-provider";
export {
  CCC_SEARCH_TIMEOUT_MS,
  CCC_VERSION_TIMEOUT_MS,
  CocoIndexCandidateProvider,
  CocoIndexProviderError,
} from "./cocoindex-provider";
export type { CocoIndexOptions, CocoIndexProviderErrorCode } from "./cocoindex-provider";
export { resolveProvider } from "./resolve";
