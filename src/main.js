import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "../styles/styles.css";

const state = {
  authenticated: false,
  sessions: [],
  activeSession: "",
  terminal: null,
  fitAddon: null,
  socket: null,
  mode: "locked",
  connected: false,
  connectionStatus: "idle",
  reconnectPending: false,
  hasDisconnected: false,
  activeMenu: null,
  theme: "dark",
  stickyKeysVisible: false,
  stickyModifiers: {
    ctrl: false,
    alt: false,
    shift: false,
  },
  terminalResizeObserver: null,
  terminalTouchScrollController: null,
  terminalSelectionCopyController: null,
  panesBySession: new Map(),
};

const app = document.querySelector("#app");
const TMUX_PREFIX = "\x02";
const BROWSER_CONTEXT_MENU_EVENTS = [
  "contextmenu",
  "mousedown",
  "mouseup",
  "auxclick",
  "pointerdown",
  "pointerup",
];
const TERMINAL_THEMES = {
  dark: {
    background: "#101214",
    foreground: "#e6e0d4",
    cursor: "#f2c14e",
    selectionBackground: "#365a73",
    black: "#171a1d",
    red: "#d25b53",
    green: "#7aa66d",
    yellow: "#d9a441",
    blue: "#5c8fbf",
    magenta: "#a678b5",
    cyan: "#65a8a6",
    white: "#e6e0d4",
    brightBlack: "#52585f",
    brightRed: "#ff786e",
    brightGreen: "#9ccf8a",
    brightYellow: "#f2c14e",
    brightBlue: "#7bb4e3",
    brightMagenta: "#c996d8",
    brightCyan: "#8bd4d1",
    brightWhite: "#fff8ec",
  },
  light: {
    background: "#f7f8f3",
    foreground: "#1f2928",
    cursor: "#a36313",
    selectionBackground: "#c3d8d3",
    black: "#121817",
    red: "#b74437",
    green: "#4f7b3a",
    yellow: "#94670f",
    blue: "#3f6fae",
    magenta: "#8657a5",
    cyan: "#0f766e",
    white: "#e8ece4",
    brightBlack: "#697471",
    brightRed: "#d45a4b",
    brightGreen: "#68994f",
    brightYellow: "#b87a12",
    brightBlue: "#527fbd",
    brightMagenta: "#9a6bb7",
    brightCyan: "#16897f",
    brightWhite: "#ffffff",
  },
};

function api(path, options = {}) {
  return fetch(path, {
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  }).then(async (response) => {
    if (response.status === 401) {
      state.authenticated = false;
      render();
      throw new Error("unauthorized");
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(body.error || response.statusText);
    }
    return response.json();
  });
}

async function bootstrap() {
  await loadConfig();
  const me = await fetch("/api/me", { credentials: "same-origin" }).then((res) => res.json());
  state.authenticated = me.authenticated;
  render();
  if (state.authenticated) {
    await refreshSessions();
  }
}

async function loadConfig() {
  const config = await fetch("/api/config", { credentials: "same-origin" })
    .then((res) => (res.ok ? res.json() : {}))
    .catch(() => ({}));
  applyTheme(config.theme);
}

function applyTheme(theme) {
  state.theme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = state.theme;
}

function render() {
  if (!state.authenticated) {
    renderLogin();
    return;
  }
  renderShell();
}

function renderLogin() {
  app.innerHTML = `
    <main class="login-surface">
      <section class="login-panel">
        <div class="login-mark">tmux web</div>
        <form id="login-form" class="login-form">
          <input id="token" type="password" autocomplete="current-password" placeholder="Token" autofocus />
          <button type="submit">Connect</button>
        </form>
        <p id="login-error" class="login-error" role="alert"></p>
      </section>
    </main>
  `;
  document.querySelector("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = document.querySelector("#login-error");
    error.textContent = "";
    const token = document.querySelector("#token").value;
    try {
      await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      state.authenticated = true;
      renderShell();
      await refreshSessions();
    } catch (err) {
      error.textContent = err.message;
    }
  });
}

function renderShell() {
  app.innerHTML = `
    <main class="workspace">
      <header class="tabbar">
        <div id="tabs" class="tabs"></div>
        <div class="tab-actions">
          <button id="refresh" class="icon-button" title="Refresh sessions">R</button>
          <button id="new-session" class="primary-button">New</button>
        </div>
      </header>
      <section class="terminal-stage">
        <div id="terminal" class="terminal"></div>
        <div id="empty-state" class="empty-state">
          <div>No tmux session selected</div>
          <button id="empty-new">Create session</button>
        </div>
        <div id="connection-overlay" class="connection-overlay" hidden></div>
      </section>
      <div id="sticky-keys" class="sticky-keys" hidden></div>
      <footer id="command-bar" class="command-bar"></footer>
      <aside id="command-panel" class="command-panel" hidden></aside>
    </main>
  `;
  document.querySelector("#new-session").addEventListener("click", () => createSession());
  document.querySelector("#empty-new").addEventListener("click", () => createSession());
  document.querySelector("#refresh").addEventListener("click", () => refreshSessions());
  renderTabs();
  renderCommandBar();
  renderStickyKeys();
  renderConnectionOverlay();
  mountTerminal();
}

function renderTabs() {
  const tabs = document.querySelector("#tabs");
  if (!tabs) return;
  tabs.innerHTML = "";
  state.sessions.forEach((session) => {
    const tab = document.createElement("button");
    tab.className = `session-tab ${session.name === state.activeSession ? "active" : ""}`;
    tab.title = session.name;
    tab.innerHTML = `
      <span class="session-name">${escapeHtml(session.name)}</span>
      <span class="session-meta">${session.windows}w</span>
      <span class="close-tab" title="Kill session" data-close="${escapeAttr(session.name)}">x</span>
    `;
    tab.addEventListener("click", (event) => {
      const closeName = event.target.getAttribute("data-close");
      if (closeName) {
        event.stopPropagation();
        killSession(closeName);
        return;
      }
      setActiveSession(session.name);
    });
    tabs.append(tab);
  });
}

function renderCommandBar() {
  const bar = document.querySelector("#command-bar");
  if (!bar) return;
  const locked = state.mode === "locked";
  bar.className = `command-bar ${locked ? "command-bar-locked" : "command-bar-unlocked"}`;
  document.querySelector(".workspace")?.classList.toggle("command-bar-locked", locked);
  const items = locked
    ? [
        { key: "Ctrl+g", label: "Unlock", action: "toggle-mode" },
        { key: "Ctrl+b", label: "Prefix", action: "send-prefix" },
      ]
    : [
        { key: "Ctrl+g", label: "Lock", action: "toggle-mode" },
        { key: "s", label: "Session", menu: "session" },
        { key: "p", label: "Pane", menu: "pane" },
        { key: "w", label: "Window", menu: "window" },
        { key: "b", label: "Prefix", action: "send-prefix" },
        { key: "?", label: "Help", menu: "help" },
      ];
  bar.innerHTML = `
    <div class="mode-pill ${locked ? "locked" : "unlocked"}">${locked ? "LOCKED" : "COMMAND"}</div>
    <div class="command-items">
      ${items.map((item) => `
        <button class="command-item ${item.menu && state.activeMenu === item.menu ? "active" : ""}"
          data-action="${escapeAttr(item.action || "")}"
          data-menu="${escapeAttr(item.menu || "")}">
          <kbd>${escapeHtml(item.key)}</kbd><span>${escapeHtml(item.label)}</span>
        </button>
      `).join("")}
      <button id="sticky-toggle" class="sticky-toggle ${state.stickyKeysVisible ? "active" : ""}"
        title="Show or hide sticky keys"
        aria-label="Show or hide sticky keys"
        aria-pressed="${state.stickyKeysVisible ? "true" : "false"}">
        <span class="sticky-toggle-icon" aria-hidden="true">⌨</span>
      </button>
    </div>
  `;
  bar.querySelectorAll(".command-item").forEach((button) => {
    button.addEventListener("click", () => {
      const menu = button.dataset.menu;
      if (menu) {
        openCommandMenu(menu);
        return;
      }
      runTopLevelCommand(button.dataset.action);
    });
  });
  document.querySelector("#sticky-toggle")?.addEventListener("click", () => {
    state.stickyKeysVisible = !state.stickyKeysVisible;
    renderCommandBar();
    renderStickyKeys();
    if (state.terminal) state.terminal.focus();
  });
  renderCommandPanel();
}

function renderStickyKeys() {
  const bar = document.querySelector("#sticky-keys");
  if (!bar) return;
  document.querySelector(".workspace")?.classList.toggle("sticky-keys-open", state.stickyKeysVisible);
  bar.hidden = !state.stickyKeysVisible;
  if (!state.stickyKeysVisible) {
    bar.innerHTML = "";
    requestTerminalFit({ settle: true });
    return;
  }
  const keys = [
    { id: "esc", label: "Esc", kind: "send", data: "\x1b" },
    { id: "tab", label: "Tab", kind: "send", data: "\t" },
    { id: "ctrl", label: "Ctrl", kind: "modifier" },
    { id: "alt", label: "Alt", kind: "modifier" },
    { id: "shift", label: "Shift", kind: "modifier" },
    { id: "enter", label: "Ent", kind: "send", data: "\r" },
    { id: "left", label: "←", kind: "special" },
    { id: "down", label: "↓", kind: "special" },
    { id: "up", label: "↑", kind: "special" },
    { id: "right", label: "→", kind: "special" },
  ];
  bar.innerHTML = `
    <div class="sticky-key-row">
      ${keys.map((key) => `
        <button class="sticky-key ${key.kind === "modifier" && state.stickyModifiers[key.id] ? "active" : ""}"
          data-id="${escapeAttr(key.id)}"
          data-kind="${escapeAttr(key.kind)}"
          data-data="${escapeAttr(key.data || "")}"
          aria-pressed="${key.kind === "modifier" && state.stickyModifiers[key.id] ? "true" : "false"}">
          ${escapeHtml(key.label)}
        </button>
      `).join("")}
    </div>
  `;
  bar.querySelectorAll(".sticky-key").forEach((button) => {
    button.addEventListener("click", () => handleStickyKey(button.dataset));
  });
  requestTerminalFit({ settle: true });
}

function handleStickyKey(dataset) {
  const id = dataset.id;
  const kind = dataset.kind;
  if (kind === "modifier" && id in state.stickyModifiers) {
    state.stickyModifiers[id] = !state.stickyModifiers[id];
    renderStickyKeys();
    if (state.terminal) state.terminal.focus();
    return;
  }
  if (kind === "special") {
    sendInput(composeSpecialKey(id));
  } else if (kind === "send") {
    if (id === "esc") {
      clearStickyModifiers();
      sendInput("\x1b");
    } else {
      sendInput(applyStickyModifiers(dataset.data || ""));
    }
  }
  renderStickyKeys();
  if (state.terminal) state.terminal.focus();
}

function renderCommandPanel() {
  const panel = document.querySelector("#command-panel");
  if (!panel) return;
  if (state.mode === "locked" || !state.activeMenu) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const menu = getCommandMenus()[state.activeMenu];
  if (!menu) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  panel.innerHTML = `
    <div class="command-panel-head">
      <div>
        <div class="command-panel-title">${escapeHtml(menu.label)}</div>
        <div class="command-panel-subtitle">${escapeHtml(menu.subtitle)}</div>
      </div>
      <button class="command-panel-close" data-close-menu title="Close submenu">Esc</button>
    </div>
    <div class="submenu-grid">
      ${menu.actions.map((action) => `
        <button class="submenu-action ${action.danger ? "danger" : ""}"
          data-command="${escapeAttr(action.id)}">
          <kbd>${escapeHtml(action.key)}</kbd>
          <span>
            <strong>${escapeHtml(action.label)}</strong>
            <small>${escapeHtml(action.detail)}</small>
          </span>
        </button>
      `).join("")}
    </div>
  `;
  panel.querySelector("[data-close-menu]").addEventListener("click", closeCommandMenu);
  panel.querySelectorAll(".submenu-action").forEach((button) => {
    button.addEventListener("click", () => executeMenuAction(button.dataset.command));
  });
}

function getCommandMenus() {
  return {
    session: {
      label: "Session",
      subtitle: "Manage browser tabs backed by tmux sessions.",
      actions: [
        { id: "session-new", key: "n", label: "New session", detail: "Create a session and open it as a tab" },
        { id: "session-rename", key: "r", label: "Rename session", detail: "Rename the active tmux session" },
        { id: "session-kill", key: "x", label: "Kill session", detail: "Close the active tmux session", danger: true },
        { id: "session-prev", key: "[", label: "Previous tab", detail: "Switch to the previous session tab" },
        { id: "session-next", key: "]", label: "Next tab", detail: "Switch to the next session tab" },
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
        { id: "help-session", key: "s", label: "Session menu", detail: "Create, rename, kill, and switch session tabs" },
        { id: "help-pane", key: "p", label: "Pane menu", detail: "Split, focus, zoom, layout, and kill panes" },
        { id: "help-window", key: "w", label: "Window menu", detail: "Create, rename, switch, and kill tmux windows" },
        { id: "help-lock", key: "Ctrl+g", label: "Lock", detail: "Return all keyboard input to tmux" },
        { id: "help-back", key: "Esc", label: "Back", detail: "Close the current submenu" },
      ],
    },
  };
}

async function refreshSessions() {
  const data = await api("/api/sessions");
  state.sessions = data.sessions;
  const sessionNames = new Set(state.sessions.map((session) => session.name));
  for (const sessionName of state.panesBySession.keys()) {
    if (!sessionNames.has(sessionName)) state.panesBySession.delete(sessionName);
  }
  if (!state.activeSession && state.sessions.length) {
    state.activeSession = state.sessions[0].name;
  }
  if (state.activeSession && !state.sessions.some((session) => session.name === state.activeSession)) {
    state.activeSession = state.sessions[0]?.name || "";
  }
  renderTabs();
  mountTerminal();
}

async function createSession() {
  const name = window.prompt("Session name", `web-${Math.random().toString(16).slice(2, 8)}`);
  if (name === null) return;
  const data = await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ name: name.trim() || null }),
  });
  await refreshSessions();
  setActiveSession(data.session.name);
}

async function killSession(name = state.activeSession) {
  if (!name) return;
  if (!window.confirm(`Kill tmux session "${name}"?`)) return;
  await api(`/api/sessions/${encodeURIComponent(name)}`, { method: "DELETE" });
  state.panesBySession.delete(name);
  if (state.activeSession === name) {
    closeSocket({ disposeTerminal: true, intentional: true });
    state.activeSession = "";
  }
  await refreshSessions();
}

async function renameActiveSession() {
  if (!state.activeSession) return;
  const name = window.prompt("New session name", state.activeSession);
  if (name === null || name.trim() === "" || name.trim() === state.activeSession) return;
  const oldName = state.activeSession;
  const data = await api(`/api/sessions/${encodeURIComponent(oldName)}`, {
    method: "PUT",
    body: JSON.stringify({ name: name.trim() }),
  });
  state.panesBySession.delete(oldName);
  await refreshSessions();
  setActiveSession(data.session.name);
}

function setActiveSession(name) {
  if (state.activeSession === name) return;
  state.activeSession = name;
  state.activeMenu = null;
  renderTabs();
  renderCommandBar();
  mountTerminal(true);
}

function mountTerminal(forceReconnect = false) {
  const terminalElement = document.querySelector("#terminal");
  const empty = document.querySelector("#empty-state");
  if (!terminalElement || !empty) return;
  empty.hidden = Boolean(state.activeSession);
  terminalElement.hidden = !state.activeSession;
  if (!state.activeSession) {
    closeSocket({ disposeTerminal: true, intentional: true });
    return;
  }
  if (state.terminal && !forceReconnect) {
    observeTerminalSize(terminalElement);
    fitAndResize();
    return;
  }
  closeSocket({ disposeTerminal: true, intentional: true });
  terminalElement.innerHTML = "";
  state.terminal = new Terminal({
    allowProposedApi: false,
    cursorBlink: true,
    cursorStyle: "block",
    convertEol: false,
    fontFamily: '"Berkeley Mono", "JetBrains Mono", "Cascadia Mono", "SFMono-Regular", monospace',
    fontSize: 14,
    lineHeight: 1.12,
    macOptionClickForcesSelection: true,
    scrollback: 5000,
    theme: TERMINAL_THEMES[state.theme],
  });
  state.fitAddon = new FitAddon();
  state.terminal.loadAddon(state.fitAddon);
  state.terminal.open(terminalElement);
  observeTerminalSize(terminalElement);
  installTerminalTouchScroll(terminalElement);
  installTerminalSelectionCopy(terminalElement);
  state.terminal.attachCustomKeyEventHandler(handleTerminalKeyEvent);
  state.terminal.onData((data) => {
    if (state.mode === "locked") {
      sendInput(applyStickyModifiers(data));
      renderStickyKeys();
    }
  });
  connectTerminal();
  requestAnimationFrame(() => {
    fitAndResize();
    state.terminal.focus();
  });
}

function connectTerminal() {
  if (!state.activeSession || !state.terminal) return;
  state.reconnectPending = false;
  state.connectionStatus = state.hasDisconnected ? "reconnecting" : "connecting";
  renderConnectionOverlay();
  const { cols, rows } = proposedSize();
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const params = new URLSearchParams({
    session: state.activeSession,
    cols: String(cols),
    rows: String(rows),
  });
  const socket = new WebSocket(`${protocol}://${location.host}/ws/terminal?${params}`);
  socket.binaryType = "arraybuffer";
  state.socket = socket;
  state.connected = false;
  renderCommandBar();
  socket.addEventListener("open", () => {
    state.connected = true;
    state.connectionStatus = "connected";
    if (state.hasDisconnected) {
      renderConnectionOverlay("Reconnected", 900);
    } else {
      renderConnectionOverlay();
    }
    state.hasDisconnected = false;
    renderCommandBar();
    fitAndResize();
    schedulePaneLayoutRefresh(90);
    if (state.terminal) state.terminal.focus();
  });
  socket.addEventListener("message", (event) => {
    if (!state.terminal) return;
    if (event.data instanceof ArrayBuffer) {
      state.terminal.write(new Uint8Array(event.data));
    } else {
      state.terminal.write(event.data);
    }
  });
  socket.addEventListener("error", () => {
    if (socket === state.socket) {
      state.connectionStatus = "disconnected";
    }
  });
  socket.addEventListener("close", (event) => {
    if (socket._tmuxWebIntentionalClose) return;
    state.connected = false;
    state.connectionStatus = "disconnected";
    state.reconnectPending = true;
    state.hasDisconnected = true;
    renderCommandBar();
    renderConnectionOverlay(
      event.code ? `Connection closed (${event.code})` : "Connection closed",
    );
    if (state.terminal) state.terminal.focus();
  });
}

function closeSocket({ disposeTerminal = true, intentional = true } = {}) {
  if (state.socket) {
    state.socket._tmuxWebIntentionalClose = intentional;
    state.socket.close();
  }
  state.socket = null;
  state.connected = false;
  state.reconnectPending = false;
  state.connectionStatus = "idle";
  if (intentional) {
    state.hasDisconnected = false;
  }
  renderConnectionOverlay();
  if (disposeTerminal && state.terminalResizeObserver) {
    state.terminalResizeObserver.disconnect();
    state.terminalResizeObserver = null;
  }
  if (disposeTerminal && state.terminalTouchScrollController) {
    state.terminalTouchScrollController.abort();
    state.terminalTouchScrollController = null;
  }
  if (disposeTerminal && state.terminalSelectionCopyController) {
    state.terminalSelectionCopyController.abort();
    state.terminalSelectionCopyController = null;
  }
  if (disposeTerminal && state.terminal) {
    state.terminal.dispose();
    state.terminal = null;
    state.fitAddon = null;
  }
}

async function reconnectTerminal() {
  if (!state.activeSession || !state.terminal || !state.reconnectPending) return;
  state.connected = false;
  state.reconnectPending = false;
  state.connectionStatus = "reconnecting";
  renderConnectionOverlay("Reconnecting...");
  const canReconnect = await verifyAuthForReconnect();
  if (!canReconnect) return;
  if (state.socket) {
    state.socket._tmuxWebIntentionalClose = true;
    state.socket.close();
  }
  state.socket = null;
  connectTerminal();
}

async function verifyAuthForReconnect() {
  try {
    const response = await fetch("/api/me", { credentials: "same-origin" });
    if (!response.ok) throw new Error(response.statusText);
    const me = await response.json();
    if (me.authenticated) return true;
    state.authenticated = false;
    state.reconnectPending = false;
    state.connectionStatus = "idle";
    renderLogin();
    return false;
  } catch (_) {
    state.connected = false;
    state.reconnectPending = true;
    state.connectionStatus = "disconnected";
    renderConnectionOverlay("Server unavailable");
    if (state.terminal) state.terminal.focus();
    return false;
  }
}

let overlayTimer = 0;
function renderConnectionOverlay(message, timeout = 0) {
  const overlay = document.querySelector("#connection-overlay");
  if (!overlay) return;
  window.clearTimeout(overlayTimer);
  if (message === "Reconnected") {
    overlay.innerHTML = `<div class="connection-card transient"><strong>${escapeHtml(message)}</strong></div>`;
    overlay.hidden = false;
    overlayTimer = window.setTimeout(() => renderConnectionOverlay(), timeout);
    return;
  }
  if (state.reconnectPending) {
    overlay.innerHTML = `
      <div class="connection-card">
        <strong>${escapeHtml(message || "Connection closed")}</strong>
        <span>Press <kbd>Enter</kbd> to reconnect</span>
      </div>
    `;
    overlay.hidden = false;
    return;
  }
  if (state.connectionStatus === "connecting" || state.connectionStatus === "reconnecting") {
    overlay.innerHTML = `
      <div class="connection-card transient">
        <strong>${state.connectionStatus === "reconnecting" ? "Reconnecting..." : "Connecting..."}</strong>
      </div>
    `;
    overlay.hidden = false;
    return;
  }
  overlay.hidden = true;
  overlay.innerHTML = "";
}

let paneLayoutRefreshTimer = 0;
function schedulePaneLayoutRefresh(delay = 0) {
  window.clearTimeout(paneLayoutRefreshTimer);
  paneLayoutRefreshTimer = window.setTimeout(() => {
    void refreshPaneLayout();
  }, delay);
}

async function refreshPaneLayout(sessionName = state.activeSession) {
  if (!sessionName) return [];
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(sessionName)}/panes`);
    const panes = Array.isArray(data.panes) ? data.panes : [];
    state.panesBySession.set(sessionName, panes);
    return panes;
  } catch (_) {
    state.panesBySession.delete(sessionName);
    return [];
  }
}

function getCachedPanes(sessionName = state.activeSession) {
  return state.panesBySession.get(sessionName) || [];
}

function sendInput(data) {
  if (!data) return;
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify({ type: "input", data }));
}

function applyStickyModifiers(data) {
  if (!hasStickyModifiers() || data.length === 0) return data;
  const first = data[0];
  let transformed = first;
  if (state.stickyModifiers.shift && isAsciiLetter(transformed)) {
    transformed = transformed.toUpperCase();
  }
  if (state.stickyModifiers.ctrl) {
    transformed = ctrlTransform(transformed);
  }
  if (state.stickyModifiers.alt) {
    transformed = `\x1b${transformed}`;
  }
  clearStickyModifiers();
  return `${transformed}${data.slice(1)}`;
}

function composeSpecialKey(id) {
  const final = { up: "A", down: "B", right: "C", left: "D" }[id];
  if (!final) return "";
  if (!hasStickyModifiers()) return `\x1b[${final}`;
  const code = 1
    + (state.stickyModifiers.shift ? 1 : 0)
    + (state.stickyModifiers.alt ? 2 : 0)
    + (state.stickyModifiers.ctrl ? 4 : 0);
  clearStickyModifiers();
  return `\x1b[1;${code}${final}`;
}

function hasStickyModifiers() {
  return state.stickyModifiers.ctrl || state.stickyModifiers.alt || state.stickyModifiers.shift;
}

function clearStickyModifiers() {
  state.stickyModifiers.ctrl = false;
  state.stickyModifiers.alt = false;
  state.stickyModifiers.shift = false;
}

function ctrlTransform(value) {
  if (value.length === 0) return value;
  const upper = value[0].toUpperCase();
  const code = upper.charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  if (value === " ") return "\x00";
  return value;
}

function isAsciiLetter(value) {
  return /^[a-z]$/i.test(value);
}

function sendResize(cols, rows) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify({ type: "resize", cols, rows }));
}

function proposedSize() {
  const fallback = { cols: 100, rows: 30 };
  if (!state.fitAddon) return fallback;
  return state.fitAddon.proposeDimensions() || fallback;
}

let resizeTimer = 0;
let fitFrame = 0;
let settleFitTimer = 0;
function requestTerminalFit({ settle = false } = {}) {
  if (settle) {
    window.clearTimeout(settleFitTimer);
    settleFitTimer = window.setTimeout(fitAndResize, 90);
  }
  if (fitFrame) return;
  fitFrame = window.requestAnimationFrame(() => {
    fitFrame = 0;
    fitAndResize();
  });
}

function fitAndResize() {
  if (!state.fitAddon || !state.terminal) return;
  state.fitAddon.fit();
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    const { cols, rows } = proposedSize();
    sendResize(cols, rows);
    schedulePaneLayoutRefresh(90);
  }, 40);
}

function observeTerminalSize(element) {
  if (!("ResizeObserver" in window)) return;
  if (state.terminalResizeObserver) {
    state.terminalResizeObserver.disconnect();
  }
  state.terminalResizeObserver = new ResizeObserver(() => requestTerminalFit());
  state.terminalResizeObserver.observe(element);
}

function installTerminalTouchScroll(terminalElement) {
  state.terminalTouchScrollController?.abort();

  const controller = new AbortController();
  const touchState = {
    id: null,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    vertical: false,
    locked: false,
  };
  const options = { capture: true, signal: controller.signal };

  terminalElement.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 1) {
        touchState.id = null;
        return;
      }
      const touch = event.touches[0];
      touchState.id = touch.identifier;
      touchState.startX = touch.clientX;
      touchState.startY = touch.clientY;
      touchState.lastX = touch.clientX;
      touchState.lastY = touch.clientY;
      touchState.vertical = false;
      touchState.locked = false;
    },
    { passive: true, ...options },
  );

  terminalElement.addEventListener(
    "touchmove",
    (event) => {
      if (touchState.id === null || event.touches.length !== 1) return;
      const touch = findTouch(event.touches, touchState.id);
      if (!touch) return;

      const totalX = touch.clientX - touchState.startX;
      const totalY = touch.clientY - touchState.startY;
      if (!touchState.locked) {
        const absX = Math.abs(totalX);
        const absY = Math.abs(totalY);
        if (Math.max(absX, absY) < 6) return;
        touchState.vertical = absY >= absX;
        touchState.locked = true;
      }
      if (!touchState.vertical) return;

      const deltaY = touchState.lastY - touch.clientY;
      touchState.lastX = touch.clientX;
      touchState.lastY = touch.clientY;
      if (deltaY === 0) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      dispatchTerminalWheel(terminalElement, event, touch, deltaY);
    },
    { passive: false, ...options },
  );

  const resetTouchScroll = () => {
    touchState.id = null;
    touchState.locked = false;
    touchState.vertical = false;
  };
  terminalElement.addEventListener("touchend", resetTouchScroll, options);
  terminalElement.addEventListener("touchcancel", resetTouchScroll, options);

  state.terminalTouchScrollController = controller;
}

function installTerminalSelectionCopy(terminalElement) {
  state.terminalSelectionCopyController?.abort();

  const controller = new AbortController();
  let dragSelection = null;
  let pendingSelectionCopy = null;
  const signal = controller.signal;

  terminalElement.addEventListener(
    "mousedown",
    (event) => {
      if (event.button !== 0 || !state.terminal || !state.activeSession) {
        dragSelection = null;
        return;
      }
      const sessionName = state.activeSession;
      state.terminal.clearSelection();
      dragSelection = {
        sessionName,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startCell: eventToTerminalCell(event, terminalElement),
        startBufferCell: eventToTerminalBufferCell(event, terminalElement),
        endBufferCell: null,
        moved: false,
        columnMode: event.altKey && !isMacLike(),
        panes: getCachedPanes(sessionName),
      };
      void refreshPaneLayout(sessionName).then((panes) => {
        if (dragSelection?.sessionName === sessionName) {
          dragSelection.panes = panes;
        }
      });
    },
    { capture: true, signal },
  );

  document.addEventListener(
    "mousemove",
    (event) => {
      if (!dragSelection) return;
      if (Math.hypot(event.clientX - dragSelection.startClientX, event.clientY - dragSelection.startClientY) >= 4) {
        dragSelection.moved = true;
      }
      dragSelection.endBufferCell = eventToTerminalBufferCell(event, terminalElement) || dragSelection.endBufferCell;
    },
    { capture: true, signal },
  );

  document.addEventListener(
    "mouseup",
    (event) => {
      if (!dragSelection || event.button !== 0) return;
      if (Math.hypot(event.clientX - dragSelection.startClientX, event.clientY - dragSelection.startClientY) >= 4) {
        dragSelection.moved = true;
      }
      dragSelection.endBufferCell = eventToTerminalBufferCell(event, terminalElement) || dragSelection.endBufferCell;
      const selection = dragSelection;
      dragSelection = null;
      if (!selection.moved) return;

      pendingSelectionCopy = selection;
      window.setTimeout(() => {
        if (pendingSelectionCopy === selection) pendingSelectionCopy = null;
      }, 250);
    },
    { capture: true, signal },
  );

  window.addEventListener(
    "mouseup",
    () => {
      if (!pendingSelectionCopy) return;
      const selection = pendingSelectionCopy;
      pendingSelectionCopy = null;
      copyPaneSelectionToClipboard(selection);
    },
    { signal },
  );

  const selectionDisposable = state.terminal?.onSelectionChange(() => {
    if (!pendingSelectionCopy) return;
    const selection = pendingSelectionCopy;
    pendingSelectionCopy = null;
    copyPaneSelectionToClipboard(selection);
  });
  signal.addEventListener("abort", () => selectionDisposable?.dispose(), { once: true });

  state.terminalSelectionCopyController = controller;
}

function copyPaneSelectionToClipboard(selection) {
  if (!state.terminal || state.activeSession !== selection.sessionName) return;
  if (!selection.startCell) return;

  const panes = selection.panes?.length ? selection.panes : getCachedPanes(selection.sessionName);
  const pane = panes.length
    ? findPaneContainingCell(selection.startCell, panes)
    : fallbackTerminalPane();
  if (!pane) return;

  const range = state.terminal.getSelectionPosition() || pointerSelectionRange(selection);
  if (!range) return;

  const text = buildPaneSelectionText(range, pane, selection.columnMode);
  if (!text) return;

  writeClipboardText(text);
}

function eventToTerminalCell(event, terminalElement) {
  const terminal = state.terminal;
  const screen = terminalElement.querySelector(".xterm-screen");
  if (!terminal || !screen) return null;

  const rect = screen.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || terminal.cols <= 0 || terminal.rows <= 0) return null;

  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null;

  const col = Math.floor((x / rect.width) * terminal.cols);
  const row = Math.floor((y / rect.height) * terminal.rows);
  if (col < 0 || row < 0 || col >= terminal.cols || row >= terminal.rows) return null;
  return { col, row };
}

function eventToTerminalBufferCell(event, terminalElement) {
  const cell = eventToTerminalCell(event, terminalElement);
  const viewportY = state.terminal?.buffer?.active?.viewportY;
  if (!cell || !Number.isFinite(viewportY)) return null;
  return {
    col: cell.col,
    row: viewportY + cell.row,
  };
}

function pointerSelectionRange(selection) {
  const start = selection.startBufferCell;
  const end = selection.endBufferCell;
  if (!start || !end) return null;

  if (start.row < end.row || (start.row === end.row && start.col <= end.col)) {
    return {
      start: { x: start.col, y: start.row },
      end: { x: end.col + 1, y: end.row },
    };
  }

  return {
    start: { x: end.col, y: end.row },
    end: { x: start.col + 1, y: start.row },
  };
}

function findPaneContainingCell(cell, panes) {
  return panes.find((pane) => {
    const left = Number(pane.left);
    const top = Number(pane.top);
    const width = Number(pane.width);
    const height = Number(pane.height);
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
      return false;
    }
    return cell.col >= left
      && cell.col < left + width
      && cell.row >= top
      && cell.row < top + height;
  }) || null;
}

function fallbackTerminalPane() {
  if (!state.terminal) return null;
  return {
    id: "terminal",
    left: 0,
    top: 0,
    width: state.terminal.cols,
    height: state.terminal.rows,
    active: true,
  };
}

function buildPaneSelectionText(range, pane, columnMode) {
  const terminal = state.terminal;
  const buffer = terminal?.buffer?.active;
  if (!terminal || !buffer) return "";

  const paneLeft = Number(pane.left);
  const paneTop = Number(pane.top);
  const paneWidth = Number(pane.width);
  const paneHeight = Number(pane.height);
  if (![paneLeft, paneTop, paneWidth, paneHeight].every(Number.isFinite) || paneWidth <= 0 || paneHeight <= 0) {
    return "";
  }

  const paneRight = Math.min(paneLeft + paneWidth, terminal.cols);
  const paneTopBuffer = buffer.viewportY + paneTop;
  const paneBottomBuffer = paneTopBuffer + paneHeight - 1;
  const start = {
    col: Number(range.start.x),
    row: Number(range.start.y),
  };
  const end = {
    col: Number(range.end.x),
    row: Number(range.end.y),
  };
  if (![start.col, start.row, end.col, end.row].every(Number.isFinite)) return "";

  if (columnMode) {
    return buildPaneColumnSelectionText(buffer, paneLeft, paneRight, paneTopBuffer, paneBottomBuffer, start, end);
  }
  return buildPaneNormalSelectionText(terminal, buffer, paneLeft, paneRight, paneTopBuffer, paneBottomBuffer, start, end);
}

function buildPaneNormalSelectionText(terminal, buffer, paneLeft, paneRight, paneTopBuffer, paneBottomBuffer, start, end) {
  if (start.row > end.row || (start.row === end.row && start.col > end.col)) {
    [start, end] = [end, start];
  }

  const firstRow = Math.max(start.row, paneTopBuffer, 0);
  const lastRow = Math.min(end.row, paneBottomBuffer, buffer.length - 1);
  const rows = [];

  for (let row = firstRow; row <= lastRow; row += 1) {
    const selectedStartCol = row === start.row ? start.col : 0;
    const selectedEndCol = row === end.row ? end.col : terminal.cols;
    appendClippedBufferLine(rows, buffer, row, Math.max(selectedStartCol, paneLeft), Math.min(selectedEndCol, paneRight), false);
  }

  return joinCopiedRows(rows);
}

function buildPaneColumnSelectionText(buffer, paneLeft, paneRight, paneTopBuffer, paneBottomBuffer, start, end) {
  const firstRow = Math.max(Math.min(start.row, end.row), paneTopBuffer, 0);
  const lastRow = Math.min(Math.max(start.row, end.row), paneBottomBuffer, buffer.length - 1);
  const selectedStartCol = Math.min(start.col, end.col);
  const selectedEndCol = Math.max(start.col, end.col);
  const rows = [];

  for (let row = firstRow; row <= lastRow; row += 1) {
    appendClippedBufferLine(rows, buffer, row, Math.max(selectedStartCol, paneLeft), Math.min(selectedEndCol, paneRight), true);
  }

  return joinCopiedRows(rows);
}

function appendClippedBufferLine(rows, buffer, row, startCol, endCol, forceNewRow) {
  if (endCol <= startCol) return;
  const line = buffer.getLine(row);
  if (!line) return;

  const text = line
    .translateToString(true, Math.max(0, startCol), Math.max(0, endCol))
    .replace(/\u00a0/g, " ");
  if (!forceNewRow && line.isWrapped && rows.length > 0) {
    rows[rows.length - 1] += text;
  } else {
    rows.push(text);
  }
}

function joinCopiedRows(rows) {
  if (!rows.length) return "";
  return rows.map((row) => row.trimEnd()).join(isWindowsLike() ? "\r\n" : "\n");
}

function writeClipboardText(text) {
  const copiedWithFallback = copyTextWithExecCommand(text);
  if (!navigator.clipboard?.writeText) return copiedWithFallback;
  try {
    void navigator.clipboard.writeText(text).catch(() => {});
    return true;
  } catch (_) {
    // Browser clipboard permissions are best-effort here; keep the terminal usable.
    return copiedWithFallback;
  }
}

function copyTextWithExecCommand(text) {
  if (!document.queryCommandSupported?.("copy")) return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch (_) {
    copied = false;
  }
  textarea.remove();
  if (state.terminal) state.terminal.focus();
  return copied;
}

function isMacLike() {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || "");
}

function isWindowsLike() {
  return /Win/.test(navigator.platform || "");
}

function findTouch(touches, id) {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches[index];
    if (touch.identifier === id) return touch;
  }
  return null;
}

function dispatchTerminalWheel(terminalElement, sourceEvent, touch, deltaY) {
  const target = terminalElement.querySelector(".xterm") || terminalElement;
  target.dispatchEvent(new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    clientX: touch.clientX,
    clientY: touch.clientY,
    screenX: touch.screenX,
    screenY: touch.screenY,
    deltaX: 0,
    deltaY,
    deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    altKey: sourceEvent.altKey,
    ctrlKey: sourceEvent.ctrlKey,
    metaKey: sourceEvent.metaKey,
    shiftKey: sourceEvent.shiftKey,
  }));
}

function syncViewportSize() {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft || 0;
  const top = viewport?.offsetTop || 0;
  const width = viewport?.width || window.innerWidth;
  const height = viewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--viewport-left", `${Math.round(left)}px`);
  document.documentElement.style.setProperty("--viewport-top", `${Math.round(top)}px`);
  document.documentElement.style.setProperty("--viewport-width", `${Math.round(width)}px`);
  document.documentElement.style.setProperty("--viewport-height", `${Math.round(height)}px`);
  requestTerminalFit();
}

function handleTerminalKeyEvent(event) {
  if (event.type !== "keydown") return true;
  if (event.defaultPrevented) return false;
  if (state.reconnectPending && event.key === "Enter") {
    event.preventDefault();
    void reconnectTerminal();
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
    void reconnectTerminal();
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

function suppressBrowserContextMenu(event) {
  if (event.type !== "contextmenu" && !isSecondaryMouseButtonEvent(event)) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function isSecondaryMouseButtonEvent(event) {
  return event.button === 2 || (event.buttons & 2) === 2;
}

function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
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
  if (lowered === "s") {
    openCommandMenu("session");
    return;
  }
  if (lowered === "p") {
    openCommandMenu("pane");
    return;
  }
  if (lowered === "w") {
    openCommandMenu("window");
    return;
  }
  if (key === "?") {
    openCommandMenu("help");
    return;
  }
  const action = getCommandMenus()[state.activeMenu]?.actions.find((item) => {
    if (item.key === "Space") return key === " ";
    return item.key.toLowerCase() === lowered || item.key === key;
  });
  if (action) {
    executeMenuAction(action.id);
  }
}

function runTopLevelCommand(action) {
  if (action === "toggle-mode") toggleMode();
  if (action === "send-prefix") {
    sendInput(TMUX_PREFIX);
    lockCommandMode();
  }
}

function toggleMode() {
  state.mode = state.mode === "locked" ? "unlocked" : "locked";
  state.activeMenu = null;
  renderCommandBar();
  if (state.terminal) state.terminal.focus();
}

function lockCommandMode() {
  state.mode = "locked";
  state.activeMenu = null;
  renderCommandBar();
  if (state.terminal) state.terminal.focus();
}

function openCommandMenu(menu) {
  state.activeMenu = menu;
  renderCommandBar();
  if (state.terminal) state.terminal.focus();
}

function closeCommandMenu() {
  state.activeMenu = null;
  renderCommandBar();
  if (state.terminal) state.terminal.focus();
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
  else if (command === "pane-zoom") sendTmuxPrefixKey("z");
  else if (command === "pane-layout") sendTmuxPrefixKey(" ");
  else if (command === "pane-kill") sendInput(`${TMUX_PREFIX}xy`);
  else if (command === "window-new") sendTmuxPrefixKey("c");
  else if (command === "window-rename") sendTmuxPrefixKey(",");
  else if (command === "window-tree") sendTmuxPrefixKey("w");
  else if (command === "window-next") sendTmuxPrefixKey("n");
  else if (command === "window-prev") sendTmuxPrefixKey("p");
  else if (command === "window-last") sendTmuxPrefixKey("l");
  else if (command === "window-kill") sendInput(`${TMUX_PREFIX}&y`);
  else if (command === "help-session") return openCommandMenu("session");
  else if (command === "help-pane") return openCommandMenu("pane");
  else if (command === "help-window") return openCommandMenu("window");
  else if (command === "help-lock") return lockCommandMode();
  else if (command === "help-back") return closeCommandMenu();
  if (command.startsWith("pane-") || command.startsWith("window-")) {
    schedulePaneLayoutRefresh(180);
  }
  lockCommandMode();
}

function sendTmuxPrefixKey(key) {
  sendInput(`${TMUX_PREFIX}${key}`);
}

function switchSession(direction) {
  if (!state.sessions.length) return;
  const index = state.sessions.findIndex((session) => session.name === state.activeSession);
  const nextIndex = (index + direction + state.sessions.length) % state.sessions.length;
  setActiveSession(state.sessions[nextIndex].name);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

syncViewportSize();
window.addEventListener("resize", syncViewportSize);
window.visualViewport?.addEventListener("resize", syncViewportSize);
window.visualViewport?.addEventListener("scroll", syncViewportSize);
BROWSER_CONTEXT_MENU_EVENTS.forEach((eventType) => {
  window.addEventListener(eventType, suppressBrowserContextMenu, { capture: true, passive: false });
});
window.addEventListener("keydown", handleGlobalKeyEvent, true);

bootstrap().catch((error) => {
  app.innerHTML = `<main class="login-surface"><section class="login-panel"><div class="login-mark">tmux web</div><p class="login-error">${escapeHtml(error.message)}</p></section></main>`;
});
