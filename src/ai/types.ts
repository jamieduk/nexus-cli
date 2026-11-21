/** Shared types for Nexus AI agent and chat modes. */

export type SelfImproveMode = 'auto' | 'guided' | 'off';

export interface AIConfig {
  initialized: boolean;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  imageModel: string;
  temperature: number;
  maxTokens: number;
  maxAgentSteps: number;
  selfImprove: SelfImproveMode;
  personalityPath: string;
  skillsDir: string;
  projectsDir: string;
  toolsDir: string;
  memoryDir: string;
  memoryPath: string;
  vaultDir: string;
  webSearch: boolean;
  extraHeaders: Record<string, string>;
}

export const DEFAULT_MODEL = 'deepseek-v4.1-flash';

export interface PermissionGrant {
  grantedAt: number;
}

export interface PermissionStore {
  grants: Record<string, PermissionGrant>;
}

export type PermissionChoice = 'once' | 'always' | 'deny';
export type PermissionOptionValue = PermissionChoice | 'suggest';

export interface PermissionDecision {
  choice: PermissionChoice;
  reason?: string;
}

export interface PermissionRequest {
  id: string;
  title: string;
  description: string;
  risk?: 'low' | 'medium' | 'high';
}

export type PermissionPrompter = (
  request: PermissionRequest,
  options: Array<{ label: string; value: PermissionOptionValue }>,
) => Promise<PermissionDecision>;

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolResult {
  ok: boolean;
  output: string;
  data?: unknown;
}

export type AgentEventKind =
  | 'assistant'
  | 'tool-start'
  | 'tool-result'
  | 'info'
  | 'error'
  | 'final';

export interface AgentEvent {
  kind: AgentEventKind;
  text: string;
  tool?: string;
  ok?: boolean;
}

export interface AgentCallbacks {
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  askUser?: (question: string) => Promise<string | null>;
  cwd?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  content: string;
  custom: boolean;
}

export interface WebUiConfig {
  enabled: boolean;
  host: string;
  port: number;
  passwordHash: string;
  salt: string;
  createdAt: number;
}
