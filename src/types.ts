/** Shared types for the Nexus terminal application. */

export type SortKey = 'name' | 'size' | 'date' | 'type';
export type SortDirection = 'asc' | 'desc';
export type FocusTarget = 'files' | 'shell';
export type ThemeName = 'tokyo-night' | 'nord' | 'mono';
export type PreviewKind =
  | 'text'
  | 'binary'
  | 'directory'
  | 'symlink'
  | 'error'
  | 'empty'
  | 'permission';

export interface FileItem {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  isExecutable: boolean;
  hidden: boolean;
  size: number;
  blocks: number;
  mtime: number;
  mode: number;
  modeString: string;
  uid: number;
  gid: number;
  user: string;
  group: string;
  extension: string;
  icon: string;
  target?: string;
}

export interface PreviewMeta {
  label: string;
  value: string;
  tone?: 'normal' | 'muted' | 'good' | 'warn' | 'bad';
}

export interface PreviewState {
  kind: PreviewKind;
  title: string;
  subtitle: string;
  lines: string[];
  meta: PreviewMeta[];
  hex: string[];
  language: string;
  scroll: number;
  loading: boolean;
  truncated: boolean;
  error?: string;
  mime?: string;
  checksum?: string;
  totalLines?: number;
}

export interface SystemInfo {
  hostname: string;
  os: string;
  kernel: string;
  uptime: string;
  load: string;
  memory: string;
  memoryPercent: number;
  cpuModel: string;
  user: string;
  shell: string;
}

export interface BashProfile {
  aliases: Map<string, string>;
  functions: Set<string>;
  env: Set<string>;
  sources: string[];
  errors: string[];
  loadedAt: number;
}

export type ShellLineKind = 'command' | 'output' | 'error' | 'info';

export interface ShellLine {
  text: string;
  kind: ShellLineKind;
}

export interface ShellState {
  cwd: string;
  previousDir: string;
  input: string;
  cursor: number;
  history: string[];
  historyIndex: number;
  output: ShellLine[];
  outputScroll: number;
  running: boolean;
  runningCommand: string;
  spinner: number;
  lastExitCode: number | null;
  lastDurationMs: number | null;
}

export interface ShellResult {
  code: number;
  output: string;
  stderr: string;
  cwd: string | null;
  durationMs: number;
  cancelled: boolean;
}

export interface Config {
  theme: ThemeName;
  nerdFonts: boolean;
  showHidden: boolean;
  dirsFirst: boolean;
  sortBy: SortKey;
  sortAsc: boolean;
  editor: string;
  pager: string;
  previewLines: number;
  maxPreviewBytes: number;
  commandTimeoutMs: number;
  historySize: number;
  confirmDelete: boolean;
  mouse: boolean;
}

export interface Palette {
  name: ThemeName;
  bg: string;
  panel: string;
  panelAlt: string;
  fg: string;
  muted: string;
  dim: string;
  border: string;
  borderFocus: string;
  accent: string;
  accent2: string;
  green: string;
  yellow: string;
  orange: string;
  red: string;
  purple: string;
  cyan: string;
  selectionBg: string;
  selectionFg: string;
  cursorBg: string;
  cursorFg: string;
  headerBg: string;
  headerFg: string;
}

export type ModalKind = 'input' | 'confirm' | 'help' | 'menu' | 'viewer' | 'message';

export interface MenuOption {
  label: string;
  value: string;
  description?: string;
  danger?: boolean;
}

export interface ModalState {
  kind: ModalKind;
  title: string;
  message: string;
  hint: string;
  input: string;
  cursor: number;
  danger: boolean;
  options: MenuOption[];
  selected: number;
  scroll: number;
  lines: string[];
}

export type KeyName =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'enter'
  | 'escape'
  | 'tab'
  | 'backspace'
  | 'delete'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'
  | 'insert'
  | 'space'
  | 'char'
  | 'f1'
  | 'f2'
  | 'f3'
  | 'f4'
  | 'f5'
  | 'f6'
  | 'f7'
  | 'f8'
  | 'f9'
  | 'f10'
  | 'f11'
  | 'f12'
  | 'ctrl-a'
  | 'ctrl-b'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'ctrl-e'
  | 'ctrl-f'
  | 'ctrl-g'
  | 'ctrl-h'
  | 'ctrl-k'
  | 'ctrl-l'
  | 'ctrl-n'
  | 'ctrl-o'
  | 'ctrl-p'
  | 'ctrl-q'
  | 'ctrl-r'
  | 'ctrl-t'
  | 'ctrl-u'
  | 'ctrl-v'
  | 'ctrl-w'
  | 'ctrl-x'
  | 'ctrl-y'
  | 'ctrl-z'
  | 'unknown';

export interface KeyEvent {
  name: KeyName;
  char?: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  raw: string;
}

export interface ViewModel {
  width: number;
  height: number;
  cwd: string;
  items: FileItem[];
  error: string;
  selectedIndex: number;
  marked: Set<string>;
  filter: string;
  sortBy: SortKey;
  sortAsc: boolean;
  showHidden: boolean;
  dirsFirst: boolean;
  preview: PreviewState;
  focus: FocusTarget;
  shell: ShellState;
  system: SystemInfo;
  bashProfile: BashProfile;
  modal: ModalState | null;
  status: string;
  statusTone: 'normal' | 'good' | 'warn' | 'bad';
  palette: Palette;
  config: Config;
  viewerOpen: boolean;
}
