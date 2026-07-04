export const TMUX_PREFIX = "\x02";

export type CommandItem = {
  key?: string;
  label: string;
  action?: string;
  menu?: string;
  mobileOnly?: boolean;
};

export const LOCKED_COMMAND_ITEMS: CommandItem[] = [
  { key: "Ctrl+g", label: "Unlock", action: "toggle-mode" },
  { label: "Panes", action: "pane-list", mobileOnly: true },
];

export const UNLOCKED_COMMAND_ITEMS: CommandItem[] = [
  { key: "Ctrl+g", label: "Lock", action: "toggle-mode" },
  { key: "s", label: "Session", menu: "session" },
  { key: "p", label: "Pane", menu: "pane" },
  { key: "w", label: "Window", menu: "window" },
  { label: "Panes", action: "pane-list", mobileOnly: true },
  { key: "?", label: "Help", menu: "help" },
];

export const COMMAND_MENUS = {
  session: {
    label: "Session",
    subtitle: "Manage the tmux session selected above the window tabs.",
    actions: [
      { id: "session-new", key: "n", label: "New session", detail: "Create a tmux session" },
      { id: "session-rename", key: "r", label: "Rename session", detail: "Rename the active tmux session" },
      { id: "session-kill", key: "x", label: "Kill session", detail: "Close the active tmux session", danger: true },
      { id: "session-prev", key: "[", label: "Previous session", detail: "Switch to the previous tmux session" },
      { id: "session-next", key: "]", label: "Next session", detail: "Switch to the next tmux session" },
      { id: "session-refresh", key: "u", label: "Refresh", detail: "Reload sessions from tmux" },
    ],
  },
  pane: {
    label: "Pane",
    subtitle: "Send default tmux pane commands to the attached client.",
    actions: [
      { id: "pane-split-right", key: "%", label: "Split right", detail: "tmux prefix + %" },
      { id: "pane-split-down", key: "\"", label: "Split down", detail: "tmux prefix + \"" },
      { id: "pane-next", key: "o", label: "Next pane", detail: "tmux prefix + o" },
      { id: "pane-last", key: ";", label: "Last pane", detail: "tmux prefix + ;" },
      { id: "pane-zoom", key: "z", label: "Zoom pane", detail: "tmux prefix + z" },
      { id: "pane-layout", key: "Space", label: "Next layout", detail: "tmux prefix + Space" },
      { id: "pane-kill", key: "x", label: "Kill pane", detail: "tmux prefix + x, then confirm", danger: true },
    ],
  },
  window: {
    label: "Window",
    subtitle: "Send default tmux window commands to the attached client.",
    actions: [
      { id: "window-new", key: "c", label: "New window", detail: "tmux prefix + c" },
      { id: "window-rename", key: ",", label: "Rename window", detail: "tmux prefix + ," },
      { id: "window-tree", key: "w", label: "Window tree", detail: "tmux prefix + w" },
      { id: "window-next", key: "n", label: "Next window", detail: "tmux prefix + n" },
      { id: "window-prev", key: "p", label: "Previous window", detail: "tmux prefix + p" },
      { id: "window-last", key: "l", label: "Last window", detail: "tmux prefix + l" },
      { id: "window-kill", key: "&", label: "Kill window", detail: "tmux prefix + &, then confirm", danger: true },
    ],
  },
  help: {
    label: "Help",
    subtitle: "Command mode is a web layer; Locked mode sends keys to tmux.",
    actions: [
      { id: "help-session", key: "s", label: "Session menu", detail: "Create, rename, kill, and switch sessions" },
      { id: "help-pane", key: "p", label: "Pane menu", detail: "Split, focus, zoom, layout, and kill panes" },
      { id: "help-window", key: "w", label: "Window menu", detail: "Create, rename, switch, and kill tmux windows" },
      { id: "help-lock", key: "Ctrl+g", label: "Lock", detail: "Return all keyboard input to tmux" },
      { id: "help-back", key: "Esc", label: "Back", detail: "Close the current submenu" },
    ],
  },
};
