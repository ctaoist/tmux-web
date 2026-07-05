import { api, fetchConfig, fetchMe } from "./api";
import { isEditableTarget } from "./browser";
import { COMMAND_MENUS, TMUX_PREFIX } from "./commands";
import {
  applyStickyModifiersToInput,
  composeSpecialKey,
  emptyStickyModifiers,
} from "./keyboard";
import { normalizeThemePreference, type ThemeConfig } from "./terminal/themes";

function isThemeConfig(value: unknown): value is ThemeConfig {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createActions({ state, setState, getTerminal }) {
  const authorizedApi = (path: string, options: RequestInit = {}) => (
    api(path, options, handleAuthExpired)
  );

  function handleAuthExpired() {
    setState({
      authenticated: false,
      reconnectPending: false,
      connectionStatus: "idle",
      connectionMessage: "",
      connectionTransient: false,
    });
    getTerminal()?.close({ disposeTerminal: true, intentional: true });
  }

  async function bootstrap() {
    await loadConfig();
    const me = await fetchMe();
    setState({ authenticated: Boolean(me.authenticated), bootError: "" });
    if (me.authenticated) {
      await refreshSessions();
    }
  }

  async function loadConfig() {
    const config = await fetchConfig();
    applyThemeConfig(config);
  }

  function applyThemeConfig(config: ThemeConfig = { theme: "auto" }) {
    const themeConfig = isThemeConfig(config) ? config : { theme: "auto" };
    setState({
      themeConfig,
      themePreference: normalizeThemePreference(themeConfig),
    });
  }

  async function login(token) {
    await authorizedApi("/api/login", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    setState({ authenticated: true, bootError: "" });
    await refreshSessions();
  }

  async function refreshSessions({ refreshWindows: shouldRefreshWindows = true } = {}) {
    const data = await authorizedApi("/api/sessions");
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    const sessionNames = new Set(sessions.map((session) => session.name));
    getTerminal()?.retainPaneCacheForSessions(sessionNames);

    let activeSession = state.activeSession;
    if (!activeSession && sessions.length) {
      activeSession = sessions[0].name;
    }
    if (activeSession && !sessions.some((session) => session.name === activeSession)) {
      activeSession = sessions[0]?.name || "";
    }

    setState({ sessions, activeSession });
    if (shouldRefreshWindows) {
      await refreshWindows(activeSession);
    }
  }

  async function refreshWindows(sessionName = state.activeSession) {
    if (!sessionName) {
      setState({ windows: [], activeWindowId: "" });
      return [];
    }

    const windows = await getTerminal()?.listWindows(sessionName) || [];
    const activeWindowId = windows.find((window) => window.active)?.id || windows[0]?.id || "";
    setState({ windows, activeWindowId });
    return windows;
  }

  async function refreshPaneList(sessionName = state.activeSession, windowId = state.activeWindowId) {
    if (!sessionName || !windowId) {
      setState({ paneListPanes: [], paneListLoading: false });
      return [];
    }

    setState({ paneListLoading: true });
    try {
      const panes = await getTerminal()?.listWindowPanes(windowId, sessionName) || [];
      setState({ paneListPanes: panes, paneListLoading: false });
      return panes;
    } catch (error) {
      setState({ paneListLoading: false });
      throw error;
    }
  }

  function openPaneList() {
    setState({ paneListVisible: true, activeMenu: null, mode: "locked" });
    void refreshPaneList().catch(() => {});
  }

  function closePaneList() {
    setState({ paneListVisible: false });
    getTerminal()?.focus();
  }

  async function selectPane(paneId) {
    if (!state.activeSession || !state.activeWindowId || !paneId) return;
    const terminal = getTerminal();
    await terminal?.selectWindowPane(state.activeWindowId, paneId, state.activeSession);
    setState({ paneListVisible: false });
    terminal?.focus();
  }

  async function createSession() {
    const name = window.prompt("Session name", `web-${Math.random().toString(16).slice(2, 8)}`);
    if (name === null) return null;

    const data = await authorizedApi("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ name: name.trim() || null }),
    });
    await refreshSessions();
    await setActiveSession(data.session.name);
    return data.session;
  }

  async function createWindow() {
    if (!state.activeSession) return null;
    const name = window.prompt("Window name", "");
    if (name === null) return null;

    const terminal = getTerminal();
    const createdWindow = await terminal?.createWindow(name.trim() || null, state.activeSession);
    await refreshSessions({ refreshWindows: false });
    await refreshWindows(state.activeSession);
    return createdWindow;
  }

  async function killSession(name = state.activeSession) {
    if (!name) return;
    if (!window.confirm(`Kill tmux session "${name}"?`)) return;

    await authorizedApi(`/api/sessions/${encodeURIComponent(name)}`, { method: "DELETE" });
    getTerminal()?.dropPaneCache(name);
    if (state.activeSession === name) {
      getTerminal()?.close({ disposeTerminal: true, intentional: true });
      setState({ activeSession: "", activeWindowId: "", windows: [] });
    }
    await refreshSessions();
  }

  async function killWindow(windowId = state.activeWindowId) {
    if (!state.activeSession || !windowId) return;
    const tmuxWindow = state.windows.find((item) => item.id === windowId);
    const label = tmuxWindow ? `${tmuxWindow.index}:${tmuxWindow.name}` : windowId;
    if (!window.confirm(`Kill tmux window "${label}"?`)) return;

    const terminal = getTerminal();
    await terminal?.killWindow(windowId, state.activeSession);
    await refreshSessions({ refreshWindows: false });
    await refreshWindows(state.activeSession);
  }

  async function renameActiveSession() {
    if (!state.activeSession) return;
    const name = window.prompt("New session name", state.activeSession);
    if (name === null || name.trim() === "" || name.trim() === state.activeSession) return;

    const oldName = state.activeSession;
    const data = await authorizedApi(`/api/sessions/${encodeURIComponent(oldName)}`, {
      method: "PUT",
      body: JSON.stringify({ name: name.trim() }),
    });
    getTerminal()?.dropPaneCache(oldName);
    await refreshSessions();
    await setActiveSession(data.session.name);
  }

  async function setActiveSession(name) {
    if (state.activeSession === name) return;
    setState({ activeSession: name, activeMenu: null, windows: [], activeWindowId: "" });
    await refreshWindows(name);
  }

  async function setActiveWindow(windowId) {
    if (!state.activeSession || !windowId || state.activeWindowId === windowId) return;
    const selectedWindow = await getTerminal()?.selectWindow(windowId, state.activeSession);
    setState({ activeWindowId: selectedWindow?.id || windowId, activeMenu: null });
    await refreshWindows(state.activeSession);
  }

  function sendInput(data) {
    getTerminal()?.sendInput(data);
  }

  function applyStickyModifiers(data) {
    const result = applyStickyModifiersToInput(data, { ...state.stickyModifiers });
    if (result.consumed) clearStickyModifiers();
    return result.data;
  }

  function clearStickyModifiers() {
    setState("stickyModifiers", emptyStickyModifiers());
  }

  function toggleStickyKeys() {
    setState("stickyKeysVisible", !state.stickyKeysVisible);
    getTerminal()?.focus();
  }

  function handleStickyKey(key) {
    if (key.kind === "modifier" && key.id in state.stickyModifiers) {
      setState("stickyModifiers", key.id, !state.stickyModifiers[key.id]);
      getTerminal()?.focus();
      return;
    }

    if (key.kind === "special") {
      const result = composeSpecialKey(key.id, { ...state.stickyModifiers });
      if (result.consumed) clearStickyModifiers();
      sendInput(result.data);
    } else if (key.kind === "send") {
      if (key.id === "esc") {
        clearStickyModifiers();
        sendInput("\x1b");
      } else {
        sendInput(applyStickyModifiers(key.data || ""));
      }
    }

    getTerminal()?.focus();
  }

  function handleTerminalKeyEvent(event) {
    if (event.type !== "keydown") return true;
    if (event.defaultPrevented) return false;
    if (state.reconnectPending && event.key === "Enter") {
      event.preventDefault();
      void getTerminal()?.reconnect();
      return false;
    }
    if (event.ctrlKey && event.key.toLowerCase() === "g") {
      event.preventDefault();
      toggleMode();
      return false;
    }
    if (state.mode === "unlocked") {
      event.preventDefault();
      handleCommandKey(event);
      return false;
    }
    return true;
  }

  function handleGlobalKeyEvent(event) {
    if (state.reconnectPending && event.key === "Enter" && !isEditableTarget(event.target)) {
      event.preventDefault();
      void getTerminal()?.reconnect();
      return;
    }
    if (!state.authenticated || state.mode !== "unlocked") return;
    if (isEditableTarget(event.target)) return;
    if (event.defaultPrevented) return;

    event.preventDefault();
    if (event.ctrlKey && event.key.toLowerCase() === "g") {
      toggleMode();
      return;
    }
    handleCommandKey(event);
  }

  function handleCommandKey(event) {
    const key = event.key;
    const lowered = key.toLowerCase();
    if (key === "Escape" || lowered === "q") {
      closeCommandMenu();
      return;
    }
    if (!state.activeMenu) {
      if (lowered === "s") openCommandMenu("session");
      else if (lowered === "p") openCommandMenu("pane");
      else if (lowered === "w") openCommandMenu("window");
      else if (key === "?") openCommandMenu("help");
      else if (lowered === "b") runTopLevelCommand("send-prefix");
      return;
    }
    if (lowered === "s") return openCommandMenu("session");
    if (lowered === "p") return openCommandMenu("pane");
    if (lowered === "w") return openCommandMenu("window");
    if (key === "?") return openCommandMenu("help");

    const action = COMMAND_MENUS[state.activeMenu]?.actions.find((item) => {
      if (!item.key) return false;
      if (item.key === "Space") return key === " ";
      return item.key.toLowerCase() === lowered || item.key === key;
    });
    if (action) {
      void executeMenuAction(action.id);
    }
  }

  function runTopLevelCommand(action) {
    if (action === "toggle-mode") toggleMode();
    if (action === "send-prefix") {
      sendInput(TMUX_PREFIX);
      lockCommandMode();
    }
    if (action === "pane-list") {
      openPaneList();
    }
  }

  function toggleMode() {
    setState({
      mode: state.mode === "locked" ? "unlocked" : "locked",
      activeMenu: null,
      paneListVisible: false,
    });
    getTerminal()?.focus();
  }

  function lockCommandMode() {
    setState({ mode: "locked", activeMenu: null });
    getTerminal()?.focus();
  }

  function openCommandMenu(menu) {
    setState({ activeMenu: menu, paneListVisible: false });
    getTerminal()?.focus();
  }

  function closeCommandMenu() {
    setState("activeMenu", null);
    getTerminal()?.focus();
  }

  async function executeMenuAction(command) {
    if (command === "session-new") await createSession();
    else if (command === "session-rename") await renameActiveSession();
    else if (command === "session-kill") await killSession();
    else if (command === "session-prev") switchSession(-1);
    else if (command === "session-next") switchSession(1);
    else if (command === "session-refresh") await refreshSessions();
    else if (command === "pane-split-right") sendTmuxPrefixKey("%");
    else if (command === "pane-split-down") sendTmuxPrefixKey("\"");
    else if (command === "pane-next") sendTmuxPrefixKey("o");
    else if (command === "pane-last") sendTmuxPrefixKey(";");
    else if (command === "pane-zoom") {
      getTerminal()?.noteManualPaneZoom();
      sendTmuxPrefixKey("z");
    }
    else if (command === "pane-layout") sendTmuxPrefixKey(" ");
    else if (command === "pane-kill") sendInput(`${TMUX_PREFIX}xy`);
    else if (command === "window-new") await createWindow();
    else if (command === "window-rename") sendTmuxPrefixKey(",");
    else if (command === "window-tree") sendTmuxPrefixKey("w");
    else if (command === "window-next") await switchWindow(1);
    else if (command === "window-prev") await switchWindow(-1);
    else if (command === "window-last") sendTmuxPrefixKey("l");
    else if (command === "window-kill") await killWindow();
    else if (command === "help-session") return openCommandMenu("session");
    else if (command === "help-pane") return openCommandMenu("pane");
    else if (command === "help-window") return openCommandMenu("window");
    else if (command === "help-lock") return lockCommandMode();
    else if (command === "help-back") return closeCommandMenu();

    lockCommandMode();
  }

  function sendTmuxPrefixKey(key) {
    sendInput(`${TMUX_PREFIX}${key}`);
  }

  function switchSession(direction) {
    if (!state.sessions.length) return;
    const index = state.sessions.findIndex((session) => session.name === state.activeSession);
    const nextIndex = (index + direction + state.sessions.length) % state.sessions.length;
    void setActiveSession(state.sessions[nextIndex].name);
  }

  async function switchWindow(direction) {
    if (!state.windows.length) return;
    const index = state.windows.findIndex((window) => window.id === state.activeWindowId);
    const nextIndex = (Math.max(index, 0) + direction + state.windows.length) % state.windows.length;
    await setActiveWindow(state.windows[nextIndex].id);
  }

  return {
    applyStickyModifiers,
    bootstrap,
    closeCommandMenu,
    closePaneList,
    createSession,
    createWindow,
    executeMenuAction,
    handleAuthExpired,
    handleGlobalKeyEvent,
    handleStickyKey,
    handleTerminalKeyEvent,
    killSession,
    killWindow,
    login,
    openCommandMenu,
    openPaneList,
    refreshPaneList,
    refreshSessions,
    refreshWindows,
    runTopLevelCommand,
    selectPane,
    setActiveSession,
    setActiveWindow,
    toggleStickyKeys,
  };
}
