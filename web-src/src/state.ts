export const DEFAULT_STICKY_MODIFIERS = {
  ctrl: false,
  alt: false,
  shift: false,
};

export function createInitialState() {
  return {
    authenticated: false,
    bootError: "",
    sessions: [],
    activeSession: "",
    windows: [],
    activeWindowId: "",
    paneListVisible: false,
    paneListLoading: false,
    paneListPanes: [],
    mode: "locked",
    connected: false,
    connectionStatus: "idle",
    reconnectPending: false,
    hasDisconnected: false,
    connectionMessage: "",
    connectionTransient: false,
    activeMenu: null,
    themePreference: "auto",
    resolvedTheme: "dark",
    colorScheme: "dark",
    themeConfig: { theme: "auto" },
    uiTheme: {},
    terminalTheme: {},
    tmuxTheme: {},
    stickyKeysVisible: false,
    stickyModifiers: { ...DEFAULT_STICKY_MODIFIERS },
  };
}
