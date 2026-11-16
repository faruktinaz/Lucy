export { type AtomicWriteOptions, writeFileAtomic } from "./atomic-write";
export {
  CONFIG_FILE_NAME,
  type ConfigSource,
  configFilePath,
  type LoadedConfig,
  loadConfig,
  parseConfigText,
} from "./load";
export { CONFIG_MIGRATIONS, type ConfigMigration, type MigrationResult, migrateConfig } from "./migrations";
export {
  BACKUP_DIR_NAME,
  CONFIG_HEADER,
  DEFAULT_MAX_BACKUPS,
  type SaveConfigOptions,
  type SaveConfigResult,
  saveConfig,
  serializeConfig,
} from "./save";
export {
  CONFIG_SECTIONS,
  CONFIG_VERSION,
  type Config,
  type ConfigSection,
  EXTERNAL_EDITORS,
  type ExternalEditorSetting,
  getDescriptor,
  isSettingPath,
  type KeybindingOverride,
  type KeybindingOverrides,
  keybindingOverrideSchema,
  type SettingCategory,
  type SettingDescriptor,
  type SettingOption,
  type SettingPath,
  type SettingType,
  type SettingValue,
  settingsSchema,
  toSnakeCase,
} from "./schema";
export {
  type ConfigChangeEvent,
  type ConfigChangeReason,
  ConfigService,
  type SetOptions,
  type SettingEntry,
} from "./service";
export {
  type ConfigProblem,
  describeValue,
  locateKey,
  type ProblemSeverity,
  type ValidationResult,
  validateConfigTable,
} from "./validate";
export {
  changedPaths,
  cloneValue,
  deepEqual,
  defaultConfig,
  getSetting,
  isPlainObject,
  withSetting,
} from "./values";
