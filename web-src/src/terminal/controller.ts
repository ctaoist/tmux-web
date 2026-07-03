import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { api } from "../api";
import { installTerminalSelectionCopy } from "./selection";
import { TERMINAL_THEMES } from "./themes";
import { installTerminalTouchScroll } from "./touch";

type TmuxWebSocket = WebSocket & {
  _tmuxWebIntentionalClose?: boolean;
};

export function createTerminalController({
  state,
  setState,
  applyStickyModifiers,
  handleTerminalKeyEvent,
  onAuthExpired,
}) {
  const runtime = {
    terminalElement: null,
    terminal: null,
    fitAddon: null,
    socket: null,
    resizeObserver: null,
    touchScrollController: null,
    selectionCopyController: null,
    panesBySession: new Map(),
    overlayTimer: 0,
    paneLayoutRefreshTimer: 0,
    resizeTimer: 0,
    fitFrame: 0,
    settleFitTimer: 0,
  };

  function mount(element) {
    runtime.terminalElement = element;
    sync(false);
  }

  function unmount() {
    close({ disposeTerminal: true, intentional: true });
    runtime.terminalElement = null;
  }

  function sync(forceReconnect = false) {
    const terminalElement = runtime.terminalElement;
    if (!terminalElement) return;

    if (!state.activeSession) {
      close({ disposeTerminal: true, intentional: true });
      return;
    }

    if (runtime.terminal && !forceReconnect) {
      observeTerminalSize(terminalElement);
      fitAndResize();
      return;
    }

    close({ disposeTerminal: true, intentional: true });
    terminalElement.innerHTML = "";
    runtime.terminal = new Terminal({
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
    runtime.fitAddon = new FitAddon();
    runtime.terminal.loadAddon(runtime.fitAddon);
    runtime.terminal.open(terminalElement);
    observeTerminalSize(terminalElement);
    runtime.touchScrollController = installTerminalTouchScroll(terminalElement);
    runtime.selectionCopyController = installTerminalSelectionCopy({
      terminalElement,
      getTerminal: () => runtime.terminal,
      getActiveSession: () => state.activeSession,
      getCachedPanes,
      refreshPaneLayout,
      focusTerminal: focus,
    });
    runtime.terminal.attachCustomKeyEventHandler(handleTerminalKeyEvent);
    runtime.terminal.onData((data) => {
      if (state.mode === "locked") {
        sendInput(applyStickyModifiers(data));
      }
    });
    connect();
    requestAnimationFrame(() => {
      fitAndResize();
      focus();
    });
  }

  function connect() {
    if (!state.activeSession || !runtime.terminal) return;

    setState({
      reconnectPending: false,
      connectionStatus: state.hasDisconnected ? "reconnecting" : "connecting",
      connectionMessage: "",
      connectionTransient: false,
    });

    const { cols, rows } = proposedSize();
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams({
      session: state.activeSession,
      cols: String(cols),
      rows: String(rows),
    });
    const socket = new WebSocket(`${protocol}://${location.host}/ws/terminal?${params}`) as TmuxWebSocket;
    socket.binaryType = "arraybuffer";
    runtime.socket = socket;
    setState("connected", false);

    socket.addEventListener("open", () => {
      setState({
        connected: true,
        connectionStatus: "connected",
        reconnectPending: false,
      });
      if (state.hasDisconnected) {
        showTransientOverlay("Reconnected", 900);
      } else {
        clearOverlay();
      }
      setState("hasDisconnected", false);
      fitAndResize();
      schedulePaneLayoutRefresh(90);
      focus();
    });

    socket.addEventListener("message", (event) => {
      if (!runtime.terminal) return;
      if (event.data instanceof ArrayBuffer) {
        runtime.terminal.write(new Uint8Array(event.data));
      } else {
        runtime.terminal.write(event.data);
      }
    });

    socket.addEventListener("error", () => {
      if (socket === runtime.socket) {
        setState("connectionStatus", "disconnected");
      }
    });

    socket.addEventListener("close", (event) => {
      if (socket._tmuxWebIntentionalClose) return;
      setState({
        connected: false,
        connectionStatus: "disconnected",
        reconnectPending: true,
        hasDisconnected: true,
        connectionMessage: event.code ? `Connection closed (${event.code})` : "Connection closed",
        connectionTransient: false,
      });
      focus();
    });
  }

  function close({ disposeTerminal = true, intentional = true } = {}) {
    if (runtime.socket) {
      runtime.socket._tmuxWebIntentionalClose = intentional;
      runtime.socket.close();
    }
    runtime.socket = null;
    setState({
      connected: false,
      reconnectPending: false,
      connectionStatus: "idle",
      connectionMessage: "",
      connectionTransient: false,
    });
    if (intentional) {
      setState("hasDisconnected", false);
    }

    clearTimeout(runtime.overlayTimer);
    if (disposeTerminal && runtime.resizeObserver) {
      runtime.resizeObserver.disconnect();
      runtime.resizeObserver = null;
    }
    if (disposeTerminal && runtime.touchScrollController) {
      runtime.touchScrollController.abort();
      runtime.touchScrollController = null;
    }
    if (disposeTerminal && runtime.selectionCopyController) {
      runtime.selectionCopyController.abort();
      runtime.selectionCopyController = null;
    }
    if (disposeTerminal && runtime.terminal) {
      runtime.terminal.dispose();
      runtime.terminal = null;
      runtime.fitAddon = null;
    }
  }

  async function reconnect() {
    if (!state.activeSession || !runtime.terminal || !state.reconnectPending) return;
    setState({
      connected: false,
      reconnectPending: false,
      connectionStatus: "reconnecting",
      connectionMessage: "",
      connectionTransient: false,
    });

    const canReconnect = await verifyAuthForReconnect();
    if (!canReconnect) return;
    if (runtime.socket) {
      runtime.socket._tmuxWebIntentionalClose = true;
      runtime.socket.close();
    }
    runtime.socket = null;
    connect();
  }

  async function verifyAuthForReconnect() {
    try {
      const response = await fetch("/api/me", { credentials: "same-origin" });
      if (!response.ok) throw new Error(response.statusText);
      const me = await response.json();
      if (me.authenticated) return true;
      onAuthExpired();
      return false;
    } catch (_) {
      setState({
        connected: false,
        reconnectPending: true,
        connectionStatus: "disconnected",
        connectionMessage: "Server unavailable",
        connectionTransient: false,
      });
      focus();
      return false;
    }
  }

  function showTransientOverlay(message, timeout = 0) {
    clearTimeout(runtime.overlayTimer);
    setState({
      connectionMessage: message,
      connectionTransient: true,
    });
    if (timeout > 0) {
      runtime.overlayTimer = window.setTimeout(clearOverlay, timeout);
    }
  }

  function clearOverlay() {
    clearTimeout(runtime.overlayTimer);
    setState({
      connectionMessage: "",
      connectionTransient: false,
    });
  }

  function sendInput(data) {
    if (!data) return;
    if (!runtime.socket || runtime.socket.readyState !== WebSocket.OPEN) return;
    runtime.socket.send(JSON.stringify({ type: "input", data }));
  }

  function sendResize(cols, rows) {
    if (!runtime.socket || runtime.socket.readyState !== WebSocket.OPEN) return;
    runtime.socket.send(JSON.stringify({ type: "resize", cols, rows }));
  }

  function proposedSize() {
    const fallback = { cols: 100, rows: 30 };
    if (!runtime.fitAddon) return fallback;
    return runtime.fitAddon.proposeDimensions() || fallback;
  }

  function requestFit({ settle = false } = {}) {
    if (settle) {
      clearTimeout(runtime.settleFitTimer);
      runtime.settleFitTimer = window.setTimeout(fitAndResize, 90);
    }
    if (runtime.fitFrame) return;
    runtime.fitFrame = window.requestAnimationFrame(() => {
      runtime.fitFrame = 0;
      fitAndResize();
    });
  }

  function fitAndResize() {
    if (!runtime.fitAddon || !runtime.terminal) return;
    runtime.fitAddon.fit();
    clearTimeout(runtime.resizeTimer);
    runtime.resizeTimer = window.setTimeout(() => {
      const { cols, rows } = proposedSize();
      sendResize(cols, rows);
      schedulePaneLayoutRefresh(90);
    }, 40);
  }

  function observeTerminalSize(element) {
    if (!("ResizeObserver" in window)) return;
    if (runtime.resizeObserver) {
      runtime.resizeObserver.disconnect();
    }
    runtime.resizeObserver = new ResizeObserver(() => requestFit());
    runtime.resizeObserver.observe(element);
  }

  function applyTheme(theme) {
    if (runtime.terminal) {
      runtime.terminal.options.theme = TERMINAL_THEMES[theme] || TERMINAL_THEMES.dark;
    }
  }

  function focus() {
    runtime.terminal?.focus();
  }

  function schedulePaneLayoutRefresh(delay = 0) {
    clearTimeout(runtime.paneLayoutRefreshTimer);
    runtime.paneLayoutRefreshTimer = window.setTimeout(() => {
      void refreshPaneLayout();
    }, delay);
  }

  async function refreshPaneLayout(sessionName = state.activeSession) {
    if (!sessionName) return [];
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(sessionName)}/panes`, {}, onAuthExpired);
      const panes = Array.isArray(data.panes) ? data.panes : [];
      runtime.panesBySession.set(sessionName, panes);
      return panes;
    } catch (_) {
      runtime.panesBySession.delete(sessionName);
      return [];
    }
  }

  function getCachedPanes(sessionName = state.activeSession) {
    return runtime.panesBySession.get(sessionName) || [];
  }

  function prunePaneCache(sessionNames) {
    for (const sessionName of runtime.panesBySession.keys()) {
      if (!sessionNames.has(sessionName)) runtime.panesBySession.delete(sessionName);
    }
  }

  function dropPaneCache(sessionName) {
    runtime.panesBySession.delete(sessionName);
  }

  return {
    applyTheme,
    close,
    dropPaneCache,
    focus,
    mount,
    prunePaneCache,
    reconnect,
    requestFit,
    schedulePaneLayoutRefresh,
    sendInput,
    sync,
    unmount,
  };
}
