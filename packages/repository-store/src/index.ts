/** Public surface of @semantic-context/repository-store. */
export { SqliteRepositoryReader, SqliteRepositoryStore, assertUnlinkedDatabase } from "./store";
export type { ReadonlyRepositoryStore, RepositoryIndexSnapshot, RepositoryStore } from "./store";
export { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";
export {
  SEMCTX_DIR,
  semctxDir,
  configPath,
  dbPath,
  contextPacksDir,
  isInitialized,
  initWorkspace,
  saveConfig,
  toDiskConfig,
  loadConfig,
  openStore,
  openReader,
  verificationStatePath,
  assertUnlinkedWorkspace,
  assertUnlinkedBelow,
  isLinkedEntry,
  writeFileNoFollow,
} from "./workspace";
export {
  FEEDBACK_DIR_NAME,
  FEEDBACK_FILE_NAME,
  feedbackDir,
  feedbackFilePath,
  readFeedbackStore,
  writeFeedbackStore,
} from "./feedback-store";
export type { FeedbackStoreReadResult, FeedbackStoreReadStatus } from "./feedback-store";
export {
  CONFIG_MIGRATION_AFTER_FILE,
  CONFIG_MIGRATION_BEFORE_FILE,
  CONFIG_MIGRATION_MANIFEST_FILE,
  assertSafeRunId,
  assertUnlinkedConfigMigrationsTree,
  configMigrationsDir,
  coordinatorDbPath,
  generateConfigMigrationRunId,
  isConfigMigrationStructuralInvalidArtifact,
  listAbandonedConfigMigrationPreparations,
  listConfigMigrationRuns,
  publishConfigMigrationRun,
  readConfigMigrationAfter,
  readConfigMigrationBefore,
  readConfigMigrationManifest,
  readCurrentConfigBytes,
  rewriteConfigMigrationManifest,
  runDir,
  runsDir,
  swapCurrentConfigBytes,
  withConfigMigrationLock,
} from "./config-migration-store";
