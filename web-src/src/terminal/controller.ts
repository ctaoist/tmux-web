import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { api } from "../api";
import { isMobileViewport } from "../browser";
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
    responsiveZoomBySession: new Map(),
    overlayTimer: 0,
    paneLayoutRefreshTimer: 0,
    responsiveZoomTimer: 0,
    responsiveZoomRunning: false,
    responsiveZoomPending: false,
    connectionRunId: 0,
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
      scheduleResponsiveZoom(90);
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
    requestAnimationFrame(() => {
      fitTerminalViewport();
      beginConnection(state.activeSession);
      focus();
    });
  }

  function beginConnection(sessionName = state.activeSession) {
    if (!sessionName || !runtime.terminal) return;
    const runId = ++runtime.connectionRunId;
    void connectAfterResponsiveLayoutPrep(runId, sessionName);
  }

  async function connectAfterResponsiveLayoutPrep(runId, sessionName) {
    setState({
      reconnectPending: false,
      connectionStatus: state.hasDisconnected ? "reconnecting" : "connecting",
      connectionMessage: "",
      connectionTransient: false,
    });

    const prepared = await prepareResponsiveZoomBeforeAttach(sessionName);
    if (!isCurrentConnectionRun(runId, sessionName)) return;
    if (!prepared) {
      setState({
        connected: false,
        reconnectPending: true,
        hasDisconnected: true,
        connectionStatus: "disconnected",
        connectionMessage: "Unable to prepare responsive layout",
        connectionTransient: false,
      });
      focus();
      return;
    }

    connect(sessionName);
  }

  function isCurrentConnectionRun(runId, sessionName) {
    return runtime.connectionRunId === runId
      && state.activeSession === sessionName
      && Boolean(runtime.terminal);
  }

  function connect(sessionName = state.activeSession) {
    if (!sessionName || !runtime.terminal) return;

    setState({
      reconnectPending: false,
      connectionStatus: state.hasDisconnected ? "reconnecting" : "connecting",
      connectionMessage: "",
      connectionTransient: false,
    });

    fitTerminalViewport();
    const { cols, rows } = proposedSize();
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams({
      session: sessionName,
      cols: String(cols),
      rows: String(rows),
    });
    const socket = new WebSocket(`${protocol}://${location.host}/ws/terminal?${params}`) as TmuxWebSocket;
    socket.binaryType = "arraybuffer";
    runtime.socket = socket;
    setState("connected", false);

    socket.addEventListener("open", () => {
      if (socket !== runtime.socket) return;
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
      scheduleResponsiveZoom(90);
      focus();
    });

    socket.addEventListener("message", (event) => {
      if (socket !== runtime.socket) return;
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
      if (socket !== runtime.socket) return;
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
    runtime.connectionRunId += 1;
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
    clearTimeout(runtime.responsiveZoomTimer);
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
    beginConnection(state.activeSession);
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

  async function fetchWindowZoomed(sessionName) {
    const data = await api(`/api/sessions/${encodeURIComponent(sessionName)}/zoom`, {}, onAuthExpired);
    return Boolean(data.zoomed);
  }

  async function setWindowZoomed(sessionName, zoomed) {
    const data = await api(
      `/api/sessions/${encodeURIComponent(sessionName)}/zoom`,
      {
        method: "POST",
        body: JSON.stringify({ zoomed, managed: true }),
      },
      onAuthExpired,
    );
    return Boolean(data.zoomed);
  }

  async function clearResponsiveWindowZoomed(sessionName) {
    await api(
      `/api/sessions/${encodeURIComponent(sessionName)}/zoom/auto`,
      { method: "DELETE" },
      onAuthExpired,
    );
  }

  function getResponsiveZoomState(sessionName) {
    let zoomState = runtime.responsiveZoomBySession.get(sessionName);
    if (!zoomState) {
      zoomState = {
        autoZoomed: false,
        wasZoomedBeforeAuto: false,
        mobilePrepared: false,
        desktopPrepared: false,
      };
      runtime.responsiveZoomBySession.set(sessionName, zoomState);
    }
    return zoomState;
  }

  async function prepareResponsiveZoomBeforeAttach(sessionName) {
    const shouldZoom = isMobileViewport();
    const zoomState = getResponsiveZoomState(sessionName);
    let currentlyZoomed;
    try {
      currentlyZoomed = await fetchWindowZoomed(sessionName);
    } catch (_) {
      return false;
    }

    if (shouldZoom) {
      if (!zoomState.autoZoomed) {
        zoomState.wasZoomedBeforeAuto = currentlyZoomed;
      }
      if (!currentlyZoomed) {
        let zoomed;
        try {
          zoomed = await setWindowZoomed(sessionName, true);
        } catch (_) {
          return false;
        }
        zoomState.autoZoomed = zoomed;
        zoomState.mobilePrepared = zoomed;
        zoomState.desktopPrepared = false;
        return zoomed;
      }
      if (!zoomState.autoZoomed) {
        zoomState.wasZoomedBeforeAuto = true;
      }
      zoomState.mobilePrepared = true;
      zoomState.desktopPrepared = false;
      return true;
    }

    zoomState.mobilePrepared = false;
    let zoomed;
    try {
      zoomed = await setWindowZoomed(sessionName, false);
    } catch (_) {
      return false;
    }
    if (!zoomed) {
      zoomState.autoZoomed = false;
      zoomState.wasZoomedBeforeAuto = false;
    } else if (zoomState.autoZoomed && !zoomState.wasZoomedBeforeAuto) {
      zoomState.autoZoomed = false;
    } else {
      zoomState.wasZoomedBeforeAuto = true;
    }
    zoomState.desktopPrepared = true;
    return true;
  }

  function scheduleResponsiveZoom(delay = 0) {
    clearTimeout(runtime.responsiveZoomTimer);
    runtime.responsiveZoomTimer = window.setTimeout(() => {
      void runResponsiveZoomSync();
    }, delay);
  }

  async function runResponsiveZoomSync() {
    if (runtime.responsiveZoomRunning) {
      runtime.responsiveZoomPending = true;
      return;
    }

    runtime.responsiveZoomRunning = true;
    try {
      do {
        runtime.responsiveZoomPending = false;
        await syncResponsiveZoomOnce();
      } while (runtime.responsiveZoomPending);
    } finally {
      runtime.responsiveZoomRunning = false;
    }
  }

  async function syncResponsiveZoomOnce() {
    const sessionName = state.activeSession;
    if (!sessionName || !runtime.terminal || state.connectionStatus !== "connected") return;

    const shouldZoom = isMobileViewport();
    const zoomState = getResponsiveZoomState(sessionName);
    let currentlyZoomed;
    try {
      currentlyZoomed = await fetchWindowZoomed(sessionName);
    } catch (_) {
      return;
    }
    if (!isCurrentResponsiveZoomTarget(sessionName)) return;

    if (shouldZoom) {
      const wasMobilePrepared = zoomState.mobilePrepared;
      if (!zoomState.autoZoomed) {
        zoomState.wasZoomedBeforeAuto = currentlyZoomed;
      }
      if (!currentlyZoomed) {
        let zoomed;
        try {
          zoomed = await setWindowZoomed(sessionName, true);
        } catch (_) {
          return;
        }
        if (!isCurrentResponsiveZoomTarget(sessionName)) return;
        zoomState.autoZoomed = zoomed;
        zoomState.mobilePrepared = zoomed;
        zoomState.desktopPrepared = false;
        afterResponsiveZoomChange(sessionName);
      } else if (!zoomState.autoZoomed) {
        zoomState.wasZoomedBeforeAuto = true;
        zoomState.mobilePrepared = true;
        zoomState.desktopPrepared = false;
        if (!wasMobilePrepared) afterResponsiveZoomChange(sessionName);
      } else {
        zoomState.mobilePrepared = true;
        zoomState.desktopPrepared = false;
        if (!wasMobilePrepared) afterResponsiveZoomChange(sessionName);
      }
      return;
    }

    zoomState.mobilePrepared = false;
    const shouldRefresh = currentlyZoomed || zoomState.autoZoomed || !zoomState.desktopPrepared;
    let zoomed;
    try {
      zoomed = await setWindowZoomed(sessionName, false);
    } catch (_) {
      return;
    }
    if (!isCurrentResponsiveZoomTarget(sessionName)) return;
    if (!zoomed) {
      zoomState.autoZoomed = false;
      zoomState.wasZoomedBeforeAuto = false;
      zoomState.desktopPrepared = true;
      if (shouldRefresh) afterResponsiveZoomChange(sessionName);
      return;
    }
    if (zoomState.autoZoomed && !zoomState.wasZoomedBeforeAuto) {
      zoomState.autoZoomed = false;
    }
    zoomState.wasZoomedBeforeAuto = true;
    zoomState.desktopPrepared = true;
    if (shouldRefresh) afterResponsiveZoomChange(sessionName);
  }

  function isCurrentResponsiveZoomTarget(sessionName) {
    return state.activeSession === sessionName
      && Boolean(runtime.terminal)
      && state.connectionStatus === "connected";
  }

  function afterResponsiveZoomChange(sessionName) {
    requestFit({ settle: true });
    schedulePaneLayoutRefresh(140);
    if (state.activeSession === sessionName) focus();
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

  function fitTerminalViewport() {
    if (!runtime.fitAddon || !runtime.terminal) return;
    runtime.fitAddon.fit();
  }

  function fitAndResize() {
    if (!runtime.fitAddon || !runtime.terminal) return;
    fitTerminalViewport();
    if (shouldDelayResizeUntilResponsiveZoom()) {
      scheduleResponsiveZoom(0);
      return;
    }
    clearTimeout(runtime.resizeTimer);
    runtime.resizeTimer = window.setTimeout(() => {
      const { cols, rows } = proposedSize();
      sendResize(cols, rows);
      schedulePaneLayoutRefresh(90);
    }, 40);
  }

  function shouldDelayResizeUntilResponsiveZoom() {
    const sessionName = state.activeSession;
    if (!sessionName || state.connectionStatus !== "connected" || !isMobileViewport()) return false;
    return !getResponsiveZoomState(sessionName).mobilePrepared;
  }

  function observeTerminalSize(element) {
    if (!("ResizeObserver" in window)) return;
    if (runtime.resizeObserver) {
      runtime.resizeObserver.disconnect();
    }
    runtime.resizeObserver = new ResizeObserver(() => requestFit());
    runtime.resizeObserver.observe(element);
  }

  function handleViewportChange() {
    const sessionName = state.activeSession;
    if (sessionName && !isMobileViewport()) {
      getResponsiveZoomState(sessionName).desktopPrepared = false;
    }
    scheduleResponsiveZoom(0);
    requestFit({ settle: true });
  }

  function handlePageActivation() {
    const sessionName = state.activeSession;
    if (!sessionName) return;
    if (!isMobileViewport()) {
      getResponsiveZoomState(sessionName).desktopPrepared = false;
    }
    scheduleResponsiveZoom(0);
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
    scheduleResponsiveZoom(delay + 60);
  }

  async function refreshPaneLayout(sessionName = state.activeSession) {
    if (!sessionName || sessionName !== state.activeSession || !state.activeWindowId) return [];
    try {
      const data = await api(
        `/api/sessions/${encodeURIComponent(sessionName)}/windows/${encodeURIComponent(state.activeWindowId)}/panes`,
        {},
        onAuthExpired,
      );
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

  function retainPaneCacheForSessions(sessionNames) {
    for (const sessionName of runtime.panesBySession.keys()) {
      if (!sessionNames.has(sessionName)) runtime.panesBySession.delete(sessionName);
    }
    for (const sessionName of runtime.responsiveZoomBySession.keys()) {
      if (!sessionNames.has(sessionName)) runtime.responsiveZoomBySession.delete(sessionName);
    }
  }

  function dropPaneCache(sessionName) {
    runtime.panesBySession.delete(sessionName);
    runtime.responsiveZoomBySession.delete(sessionName);
  }

  function noteManualPaneZoom(sessionName = state.activeSession) {
    if (!sessionName) return;
    const zoomState = getResponsiveZoomState(sessionName);
    zoomState.autoZoomed = false;
    zoomState.wasZoomedBeforeAuto = true;
    void clearResponsiveWindowZoomed(sessionName);
  }

  return {
    applyTheme,
    close,
    dropPaneCache,
    focus,
    handlePageActivation,
    handleViewportChange,
    mount,
    noteManualPaneZoom,
    reconnect,
    retainPaneCacheForSessions,
    requestFit,
    schedulePaneLayoutRefresh,
    sendInput,
    sync,
    unmount,
  };
}
