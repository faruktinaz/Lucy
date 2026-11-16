export type {
  AgentCapabilities,
  AgentDetection,
  AgentLaunch,
  AgentLaunchMode,
  AgentLaunchOptions,
  AgentLaunchWarning,
  AgentLaunchWarningCode,
  AgentProvider,
  AgentSessionListing,
  AgentSessionSummary,
} from "./agent-provider";
export {
  type ActivityOptions,
  type AgentActivity,
  type AgentSession,
  AgentSessionManager,
  type AgentSessionManagerOptions,
  type AgentSessionManagerState,
  type CreateAgentSessionInput,
  deriveAgentActivity,
} from "./agent-session-manager";
export { inspectClaudeArgs } from "./claude-args";
export { CLAUDE_PROVIDER_ID, type ClaudeProviderConfig, createClaudeProvider } from "./claude-provider";
export {
  defaultClaudeProjectsDir,
  encodeClaudeProjectDirName,
  type ListClaudeSessionsOptions,
  listClaudeSessions,
} from "./claude-sessions";
export {
  buildPrompt,
  formatFileMention,
  getPromptTemplate,
  isPromptTemplateApplicable,
  PROMPT_TEMPLATES,
  type PromptContext,
  type PromptDiagnostic,
  type PromptRequirement,
  type PromptSelection,
  type PromptTemplate,
  type PromptTemplateId,
} from "./prompt-templates";
