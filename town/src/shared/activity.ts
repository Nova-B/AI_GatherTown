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
    case 'subagenthandback':
    case 'sendmessage':
    case 'listagents':
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

/**
 * Short Korean explanation per provider tool name (lower-cased key). Shown
 * next to the raw name - "Read(읽기)" - because the raw names (Grep, Bash,
 * Skill, apply_patch…) are not self-explanatory. Unknown names get no suffix;
 * MCP tools are described by their server.
 */
const TOOL_DESC_KO: Record<string, string> = {
  read: '읽기',
  notebookread: '노트북 읽기',
  view_image: '이미지 보기',
  read_file: '읽기',
  grep: '내용 검색',
  glob: '파일 찾기',
  ls: '목록 보기',
  list_dir: '목록 보기',
  search: '검색',
  toolsearch: '도구 찾기',
  edit: '수정',
  write: '파일 쓰기',
  multiedit: '여러 곳 수정',
  notebookedit: '노트북 수정',
  apply_patch: '패치 적용',
  write_file: '파일 쓰기',
  bash: '명령 실행',
  shell: '명령 실행',
  exec_command: '명령 실행',
  write_stdin: '입력 전달',
  local_shell: '명령 실행',
  shell_command: '명령 실행',
  powershell: '명령 실행',
  webfetch: '웹 가져오기',
  websearch: '웹 검색',
  web_search: '웹 검색',
  fetch: '가져오기',
  agent: '위임',
  task: '위임',
  spawn_agent: '에이전트 생성',
  send_input: '에이전트에 입력',
  wait_agent: '에이전트 대기',
  wait: '대기',
  subagenthandback: '결과 넘김',
  sendmessage: '메시지 전송',
  listagents: '에이전트 목록',
  todowrite: '할 일 정리',
  update_plan: '계획 갱신',
  exitplanmode: '계획 확정',
  enterplanmode: '계획 모드',
  askuserquestion: '사용자에게 질문',
  skill: '스킬 실행',
  monitor: '감시',
  workflow: '워크플로 실행',
  artifact: '아티팩트 발행',
  sendfeedback: '피드백 작성',
  schedulewakeup: '예약',
  reportfindings: '리뷰 보고',
  enterworktree: '작업 트리 진입',
  exitworktree: '작업 트리 종료',
};

const MCP_NAME = /^mcp__([^_].*?)__(.+)$/i;

/** Korean explanation for a tool name, or null when unknown. */
export function toolDescription(toolName: string | null | undefined): string | null {
  if (!toolName) return null;
  const m = MCP_NAME.exec(toolName.trim());
  if (m) return `MCP ${m[1]}`;
  return TOOL_DESC_KO[toolName.trim().toLowerCase()] ?? null;
}

/** "Read(읽기)"; MCP tools become "search(MCP server)"; unknown names stay as they are. */
export function toolLabel(toolName: string | null | undefined): string {
  if (!toolName) return '도구';
  const m = MCP_NAME.exec(toolName.trim());
  if (m) return `${m[2]}(MCP ${m[1]})`;
  const desc = toolDescription(toolName);
  return desc ? `${toolName}(${desc})` : toolName;
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
