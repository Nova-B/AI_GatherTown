import type { ActivityClass } from './events.js';

/**
 * Classify a provider tool name into a product activity class. Classification
 * is a product interpretation (drives animation and the zone a character walks
 * to); it never changes the recorded tool name.
 */
export function classifyTool(toolName: string | undefined): ActivityClass {
  if (!toolName) return 'other';
  const name = toolName.trim();
  if (/^mcp__/i.test(name) || /^mcp[_:.]/i.test(name)) return 'mcp';
  const lower = name.toLowerCase();
  switch (lower) {
    case 'read':
    case 'notebookread':
    case 'view_image':
    case 'read_file':
      return 'read';
    case 'grep':
    case 'glob':
    case 'ls':
    case 'list_dir':
    case 'search':
      return 'search';
    case 'edit':
    case 'write':
    case 'multiedit':
    case 'notebookedit':
    case 'apply_patch':
    case 'write_file':
      return 'edit';
    case 'bash':
    case 'shell':
    case 'exec_command':
    case 'write_stdin':
    case 'local_shell':
    case 'shell_command':
    case 'powershell':
      return 'shell';
    case 'webfetch':
    case 'websearch':
    case 'web_search':
    case 'fetch':
      return 'web';
    case 'agent':
    case 'task':
    case 'spawn_agent':
    case 'send_input':
    case 'wait_agent':
    case 'wait':
      return 'agent';
    case 'todowrite':
    case 'update_plan':
    case 'exitplanmode':
    case 'enterplanmode':
    case 'askuserquestion':
      return 'plan';
    default:
      return 'other';
  }
}

export const ACTIVITY_LABEL_KO: Record<ActivityClass, string> = {
  read: '읽기',
  search: '검색',
  edit: '수정',
  shell: '명령 실행',
  web: '웹',
  mcp: 'MCP',
  agent: '위임',
  plan: '계획',
  other: '도구',
};
