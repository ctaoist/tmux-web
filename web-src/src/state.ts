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
    mode: "locked",
    connected: false,
    connectionStatus: "idle",
    reconnectPending: false,
    hasDisconnected: false,
    connectionMessage: "",
    connectionTransient: false,
    activeMenu: null,
    theme: "dark",
    stickyKeysVisible: false,
    stickyModifiers: { ...DEFAULT_STICKY_MODIFIERS },
  };
}
