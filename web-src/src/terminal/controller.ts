import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
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
    controlRequests: new Map(),
    nextControlRequestId: 1,
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
    lastResizeCols: 0,
    lastResizeRows: 0,
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
    connect(runId, sessionName);
  }

  function isCurrentConnectionRun(runId, sessionName) {
    return runtime.connectionRunId === runId
      && state.activeSession === sessionName
      && Boolean(runtime.terminal);
  }

  function connect(runId, sessionName = state.activeSession) {
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
    runtime.lastResizeCols = 0;
    runtime.lastResizeRows = 0;
    setState("connected", false);

    socket.addEventListener("open", () => {
      if (socket !== runtime.socket) return;
      void attachAfterResponsiveLayoutPrep(runId, sessionName, socket);
    });

    socket.addEventListener("message", (event) => {
      if (socket !== runtime.socket) return;
      if (!runtime.terminal) return;
      if (event.data instanceof ArrayBuffer) {
        runtime.terminal.write(new Uint8Array(event.data));
      } else {
        if (handleTerminalControlMessage(event.data)) return;
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
      rejectTerminalControlRequests(new Error("terminal websocket closed"));
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

  async function attachAfterResponsiveLayoutPrep(runId, sessionName, socket) {
    const prepared = await prepareResponsiveZoomBeforeAttach(sessionName);
    if (!isCurrentConnectionRun(runId, sessionName) || socket !== runtime.socket) return;
    if (!prepared) {
      socket._tmuxWebIntentionalClose = true;
      socket.close();
      if (socket === runtime.socket) runtime.socket = null;
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

    fitTerminalViewport();
    const { cols, rows } = proposedSize();
    socket.send(JSON.stringify({ type: "attach", cols, rows }));
    rememberResize(cols, rows);
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
    scheduleResponsiveZoom(90);
    focus();
  }

  function close({ disposeTerminal = true, intentional = true } = {}) {
    runtime.connectionRunId += 1;
    if (runtime.socket) {
      runtime.socket._tmuxWebIntentionalClose = intentional;
      runtime.socket.close();
    }
    runtime.socket = null;
    rejectTerminalControlRequests(new Error("terminal websocket closed"));
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
    if (runtime.lastResizeCols === cols && runtime.lastResizeRows === rows) return;
    rememberResize(cols, rows);
    runtime.socket.send(JSON.stringify({ type: "resize", cols, rows }));
  }

  function rememberResize(cols, rows) {
    runtime.lastResizeCols = cols;
    runtime.lastResizeRows = rows;
  }

  function sendTerminalControlRequest(type, payload = {}) {
    const socket = runtime.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("terminal websocket is not connected"));
    }

    const requestId = String(runtime.nextControlRequestId++);
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        runtime.controlRequests.delete(requestId);
        reject(new Error("terminal websocket request timed out"));
      }, 8000);
      runtime.controlRequests.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({
        type,
        request_id: requestId,
        ...payload,
      }));
    });
  }

  function handleTerminalControlMessage(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch (_) {
      return false;
    }
    if (message?.type !== "terminal_response" || !message.request_id) return false;

    const pending = runtime.controlRequests.get(message.request_id);
    if (!pending) return true;
    runtime.controlRequests.delete(message.request_id);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve(message.data || {});
    } else {
      pending.reject(new Error(message.error || "terminal websocket request failed"));
    }
    return true;
  }

  function rejectTerminalControlRequests(error) {
    for (const pending of runtime.controlRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    runtime.controlRequests.clear();
  }

  function canUseTerminalControl(sessionName = state.activeSession) {
    return sessionName === state.activeSession
      && runtime.socket
      && runtime.socket.readyState === WebSocket.OPEN;
  }

  async function fetchWindowZoomed(sessionName) {
    if (!canUseTerminalControl(sessionName)) {
      throw new Error("terminal websocket is not connected");
    }
    const data: any = await sendTerminalControlRequest("get_zoom");
    return Boolean(data.zoomed);
  }

  async function setWindowZoomed(sessionName, zoomed) {
    if (!canUseTerminalControl(sessionName)) {
      throw new Error("terminal websocket is not connected");
    }
    const data: any = await sendTerminalControlRequest("set_zoom", {
      zoomed,
      managed: true,
    });
    return Boolean(data.zoomed);
  }

  async function listWindowPanes(windowId = state.activeWindowId, sessionName = state.activeSession) {
    if (!windowId || !canUseTerminalControl(sessionName)) return [];
    const data: any = await sendTerminalControlRequest("list_panes", { window_id: windowId });
    return Array.isArray(data.panes) ? data.panes : [];
  }

  async function selectWindowPane(windowId, paneId, sessionName = state.activeSession) {
    if (!windowId || !paneId || !canUseTerminalControl(sessionName)) return null;
    const data: any = await sendTerminalControlRequest("select_pane", {
      window_id: windowId,
      pane_id: paneId,
    });
    return data.pane || null;
  }

  async function clearResponsiveWindowZoomed(sessionName) {
    if (!canUseTerminalControl(sessionName)) {
      throw new Error("terminal websocket is not connected");
    }
    await sendTerminalControlRequest("clear_auto_zoom");
  }

  function getResponsiveZoomState(sessionName) {
    let zoomState = runtime.responsiveZoomBySession.get(sessionName);
    if (!zoomState) {
      zoomState = {
        autoZoomed: false,
        wasZoomedBeforeAuto: false,
        mobilePrepared: false,
        desktopPrepared: false,
        lastViewportMobile: null,
      };
      runtime.responsiveZoomBySession.set(sessionName, zoomState);
    }
    return zoomState;
  }

  function noteResponsiveViewport(zoomState, shouldZoom) {
    const previous = zoomState.lastViewportMobile;
    zoomState.lastViewportMobile = shouldZoom;
    if (previous === null || previous === undefined || previous === shouldZoom) return false;
    if (shouldZoom) {
      zoomState.mobilePrepared = false;
    } else {
      zoomState.desktopPrepared = false;
    }
    return true;
  }

  function needsResponsiveZoomSync(zoomState, shouldZoom) {
    if (shouldZoom) {
      return !zoomState.mobilePrepared;
    }
    return zoomState.autoZoomed || !zoomState.desktopPrepared;
  }

  async function prepareResponsiveZoomBeforeAttach(sessionName) {
    const shouldZoom = isMobileViewport();
    const zoomState = getResponsiveZoomState(sessionName);
    noteResponsiveViewport(zoomState, shouldZoom);
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
    noteResponsiveViewport(zoomState, shouldZoom);
    if (!needsResponsiveZoomSync(zoomState, shouldZoom)) return;

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
    if (sessionName) {
      const shouldZoom = isMobileViewport();
      const zoomState = getResponsiveZoomState(sessionName);
      const viewportChanged = noteResponsiveViewport(zoomState, shouldZoom);
      if (viewportChanged || needsResponsiveZoomSync(zoomState, shouldZoom)) {
        scheduleResponsiveZoom(0);
      }
    }
    requestFit({ settle: true });
  }

  function handlePageActivation() {
    const sessionName = state.activeSession;
    if (!sessionName) return;
    const shouldZoom = isMobileViewport();
    const zoomState = getResponsiveZoomState(sessionName);
    const viewportChanged = noteResponsiveViewport(zoomState, shouldZoom);
    if (viewportChanged || needsResponsiveZoomSync(zoomState, shouldZoom)) {
      scheduleResponsiveZoom(0);
    }
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
      const panes = await listWindowPanes(state.activeWindowId, sessionName);
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
    void clearResponsiveWindowZoomed(sessionName).catch(() => {});
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
    listWindowPanes,
    reconnect,
    retainPaneCacheForSessions,
    requestFit,
    schedulePaneLayoutRefresh,
    sendInput,
    selectWindowPane,
    sync,
    unmount,
  };
}
