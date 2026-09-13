/**
 * DEMO fixture: raw hook payloads (both providers) with relative timings.
 *
 * Played only by the explicit DEMO mode in the browser through the same
 * normalizers and reducer as live events. Nothing here is ever persisted or
 * mixed into real sessions; every event carries source 'demo'.
 */
import type { Provider } from '../shared/events.js';

export interface DemoStep {
  /** Milliseconds after the previous step. */
  after: number;
  provider: Provider;
  payload: Record<string, unknown>;
}

const CLAUDE_SID = 'demo-claude-3f2a';
const CODEX_SID = 'demo-codex-91b7';
const CWD_A = 'C:/Users/demo/projects/webshop';
const CWD_B = 'C:/Users/demo/projects/api-gateway';

export const DEMO_STEPS: DemoStep[] = [
  { after: 0, provider: 'claude', payload: { session_id: CLAUDE_SID, hook_event_name: 'SessionStart', cwd: CWD_A, reason: 'startup', model: 'claude-fable-5-1' } },
  { after: 400, provider: 'codex', payload: { session_id: CODEX_SID, hook_event_name: 'SessionStart', cwd: CWD_B, source: 'startup', model: 'gpt-5-codex' } },
  { after: 800, provider: 'claude', payload: { session_id: CLAUDE_SID, hook_event_name: 'UserPromptSubmit', cwd: CWD_A, prompt_id: 'p-1' } },
  { after: 600, provider: 'claude', payload: { session_id: CLAUDE_SID, hook_event_name: 'PreToolUse', cwd: CWD_A, tool_name: 'Grep', tool_use_id: 'toolu_c1', tool_input: { pattern: 'login', path: 'src/auth' } } },
  { after: 300, provider: 'codex', payload: { session_id: CODEX_SID, hook_event_name: 'UserPromptSubmit', cwd: CWD_B, turn_id: 't-1' } },
  { after: 500, provider: 'codex', payload: { session_id: CODEX_SID, hook_event_name: 'PreToolUse', cwd: CWD_B, turn_id: 't-1', tool_name: 'exec_command', tool_use_id: 'call_x1', tool_input: { command: 'npm test -- gateway' } } },
  { after: 900, provider: 'claude', payload: { session_id: CLAUDE_SID, hook_event_name: 'PostToolUse', cwd: CWD_A, tool_name: 'Grep', tool_use_id: 'toolu_c1', tool_input: { pattern: 'login' }, tool_response: {} } },
  { after: 400, provider: 'claude', payload: { session_id: CLAUDE_SID, hook_event_name: 'PreToolUse', cwd: CWD_A, tool_name: 'Read', tool_use_id: 'toolu_c2', tool_input: { file_path: 'C:/Users/demo/projects/webshop/src/auth/login.ts' } } },
  { after: 700, provider: 'claude', payload: { session_id: CLAUDE_SID, hook_event_name: 'PostToolUse', cwd: CWD_A, tool_name: 'Read', tool_use_id: 'toolu_c2', tool_input: {}, tool_response: {} } },
  { after: 500, provider: 'claude', payload: { session_id: CLAUDE_SID, hook_event_name: 'SubagentStart', cwd: CWD_A, agent_id: 'agent-explore-1', agent_type: 'Explore' } },
  { after: 200, provider: 'claude', payload: { session_id: CLAUDE_SID, hook_event_name: 'SubagentStart', cwd: CWD_A, agent_id: 'agent-fix-2', agent_type: 'general-purpose' } },
  { after: 500, provider: 'claude', payload: { session_id: CLAUDE_SID, hook_event_name: 'PreToolUse', cwd: CWD_A, agent_id: 'agent-explore-1', agent_type: 'Explore', tool_name: 'Grep', tool_use_id: 'toolu_e1', tool_input: { pattern: 'session cookie' } } },
  { after: 300, provider: 'claude', payload: { session_id: CLAUDE_SID, hook_event_name: 'PreToolUse', cwd: CWD_A, agent_id: 'agent-fix-2', agent_type: 'general-purpose', tool_name: 'Edit', tool_use_id: 'toolu_f1', tool_input: { file_path: 'src/auth/login.ts' } } },
  { after: 300, provider: 'claude', payload: { session_id: CLAUDE_SID, hook_event_name: 'PreToolUse', cwd: CWD_A, agent_id: 'agent-fix-2', agent_type: 'general-purpose', tool_name: 'Read', tool_use_id: 'toolu_f2', tool_input: { file_path: 'src/auth/session.ts' } } },
  { after: 800, provider: 'codex', payload: { session_id: CODEX_SID, hook_event_name: 'PostToolUse', cwd: CWD_B, turn_id: 't-1', tool_name: 'exec_command', tool_use_id: 'call_x1', tool_input: { command: 'npm test -- gateway' }, tool_response: { exit_code: 1, error: 'FAIL src/gateway.test.ts: expected 200, got 500' } } },
  { after: 600, provider: 'codex', payload: { session_id: CODEX_SID, hook_event_name: 'PreToolUse', cwd: CWD_B, turn_id: 't-1', tool_name: 'apply_patch', tool_use_id: 'call_x2', tool_input: { patch: '*** Begin Patch\n*** Update File: src/gateway.ts\n*** End Patch' } } },
  { after: 500, provider: 'claude', payload: { session_id: CLAUDE_SID, hook_event_name: 'PostToolUse', cwd: CWD_A, agent_id: 'agent-fix-2', tool_name: 'Read', tool_use_id: 'toolu_f2', tool_input: {}, tool_response: {} } },
  { after: 700, provider: 'codex', payload: { session_id: CODEX_SID, hook_event_name: 'PostToolUse', cwd: CWD_B, turn_id: 't-1', tool_name: 'apply_patch', tool_use_id: 'call_x2', tool_input: {}, tool_response: { success: true } } },
  { after: 400, provider: 'codex', payload: { session_id: CODEX_SID, hook_event_name: 'PreToolUse', cwd: CWD_B, turn_id: 't-1', tool_name: 'exec_command', tool_use_id: 'call_x3', tool_input: { command: 'git push origin main' } } },
  { after: 300, provider: 'codex', payload: { session_id: CODEX_SID, hook_event_name: 'PermissionRequest', cwd: CWD_B, turn_id: 't-1', tool_name: 'exec_command', tool_use_id: 'call_x3', tool_input: { command: 'git push origin main' } } },
  { after: 900, provider: 'claude', payload: { session_id: CLAUDE_SID, hook_event_name: 'PostToolUse', cwd: CWD_A, agent_id: 'agent-explore-1', tool_name: 'Grep', tool_use_id: 'toolu_e1', tool_input: {}, tool_response: {} } },
  { after: 500, provider: 'claude', payload: { session_id: CLAUDE_SID, hook_event_name: 'SubagentStop', cwd: CWD_A, agent_id: 'agent-explore-1', agent_type: 'Explore' } },
  { after: 600, provider: 'claude', payload: { session_id: CLAUDE_SID, hook_event_name: 'PostToolUseFailure', cwd: CWD_A, agent_id: 'agent-fix-2', tool_name: 'Edit', tool_use_id: 'toolu_f1', tool_input: { file_path: 'src/auth/login.ts' }, error: 'String to replace not found in file' } },
  { after: 700, provider: 'claude', payload: { session_id: CLAUDE_SID, hook_event_name: 'PreToolUse', cwd: CWD_A, agent_id: 'agent-fix-2', tool_name: 'Bash', tool_use_id: 'toolu_f3', tool_input: { command: 'npm test -- auth' } } },
  { after: 1500, provider: 'codex', payload: { session_id: CODEX_SID, hook_event_name: 'PostToolUse', cwd: CWD_B, turn_id: 't-1', tool_name: 'exec_command', tool_use_id: 'call_x3', tool_input: {}, tool_response: { exit_code: 0 } } },
  { after: 500, provider: 'codex', payload: { session_id: CODEX_SID, hook_event_name: 'Stop', cwd: CWD_B, turn_id: 't-1' } },
  { after: 800, provider: 'claude', payload: { session_id: CLAUDE_SID, hook_event_name: 'PostToolUse', cwd: CWD_A, agent_id: 'agent-fix-2', tool_name: 'Bash', tool_use_id: 'toolu_f3', tool_input: {}, tool_response: {} } },
  { after: 400, provider: 'claude', payload: { session_id: CLAUDE_SID, hook_event_name: 'SubagentStop', cwd: CWD_A, agent_id: 'agent-fix-2', agent_type: 'general-purpose' } },
  { after: 600, provider: 'claude', payload: { session_id: CLAUDE_SID, hook_event_name: 'PreToolUse', cwd: CWD_A, tool_name: 'Bash', tool_use_id: 'toolu_c9', tool_input: { command: 'npm run build' } } },
  { after: 1200, provider: 'claude', payload: { session_id: CLAUDE_SID, hook_event_name: 'PostToolUse', cwd: CWD_A, tool_name: 'Bash', tool_use_id: 'toolu_c9', tool_input: {}, tool_response: {} } },
  { after: 500, provider: 'claude', payload: { session_id: CLAUDE_SID, hook_event_name: 'Stop', cwd: CWD_A, stop_hook_active: false } },
  { after: 1500, provider: 'codex', payload: { session_id: CODEX_SID, hook_event_name: 'SessionEnd', cwd: CWD_B, reason: 'other' } },
];
