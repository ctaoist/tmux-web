import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import { isMobileViewport } from "../browser";
import { installTerminalSelectionCopy } from "./selection";
import { installTerminalTouchScroll } from "./touch";
import { createTrzszBridge, generateTransferId } from "./trzsz";

type TmuxWebSocket = WebSocket & {
  _tmuxWebIntentionalClose?: boolean;
};

const CLIENT_ACTIVITY_THROTTLE_MS = 250;
const POINTER_ACTIVATION_SUPPRESS_MS = 600;
const TERMINAL_METRICS_DEBUG_KEY = "tmux-web-debug-terminal-metrics";
const INPUT_BATCH_WINDOW_MS = 16;
const INPUT_BACKPRESSURE_RETRY_MS = 50;
const INPUT_BUFFERED_AMOUNT_HIGH_WATER_MARK = 128 * 1024;
const INPUT_QUEUE_MAX_BYTES = 256 * 1024;
const inputTextEncoder = new TextEncoder();

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
    trzszBridge: null,
    canvasAddon: null,
    fitAddon: null,
    socket: null,
    socketSessionName: "",
    attachedClientKind: "",
    tmuxTheme: null,
    lastTmuxThemeSignature: "",
    controlRequests: new Map(),
    nextControlRequestId: 1,
    resizeObserver: null,
    dragDropController: null,
    touchScrollController: null,
    selectionCopyController: null,
    panesBySession: new Map(),
    overlayTimer: 0,
    paneLayoutRefreshTimer: 0,
    clientActivityFrame: 0,
    lastClientActivityAt: 0,
    lastPointerActivationAt: 0,
    connectionRunId: 0,
    resizeTimer: 0,
    fitFrame: 0,
    settleFitTimer: 0,
    lastResizeCols: 0,
    lastResizeRows: 0,
    terminalMetricsLogged: false,
    pendingTerminalInput: [],
    pendingTerminalInputBytes: 0,
    inputFlushTimer: 0,
    inputQueueOverflow: false,
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
      allowProposedApi: true,
      customGlyphs: true,
      cursorBlink: true,
      cursorStyle: "block",
      convertEol: false,
      fontFamily: '"Berkeley Mono", "JetBrains Mono", "Cascadia Mono", "SFMono-Regular", monospace',
      fontSize: 14,
      letterSpacing: 0,
      lineHeight: 1,
      macOptionClickForcesSelection: true,
      scrollback: 5000,
      theme: state.terminalTheme || {},
    });
    runtime.terminalMetricsLogged = false;
    runtime.terminal.loadAddon(new Unicode11Addon());
    runtime.terminal.unicode.activeVersion = "11";
    runtime.fitAddon = new FitAddon();
    runtime.terminal.loadAddon(runtime.fitAddon);
    runtime.terminal.open(terminalElement);
    runtime.canvasAddon = new CanvasAddon();
    runtime.terminal.loadAddon(runtime.canvasAddon);
    observeTerminalSize(terminalElement);
    runtime.dragDropController = installTrzszDragDrop(terminalElement);
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
    runtime.terminal.onBinary((data) => {
      if (state.mode === "locked") {
        sendBinaryInput(data);
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

    clearQueuedTerminalInput();
    runtime.inputQueueOverflow = false;

    setState({
      reconnectPending: false,
      connectionStatus: state.hasDisconnected ? "reconnecting" : "connecting",
      connectionMessage: "",
      connectionTransient: false,
    });

    fitTerminalViewport();
    const { cols, rows } = proposedSize();
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const transferId = generateTransferId();
    const params = new URLSearchParams({
      session: sessionName,
      cols: String(cols),
      rows: String(rows),
      transfer_id: transferId,
    });
    const socket = new WebSocket(`${protocol}://${location.host}/ws/terminal?${params}`) as TmuxWebSocket;
    socket.binaryType = "arraybuffer";
    runtime.socket = socket;
    runtime.trzszBridge = createTrzszBridge({
      transferId,
      writeToTerminal,
      sendTerminalInput,
      showMessage: showTransientOverlay,
      getTerminalColumns: () => runtime.terminal?.cols || 80,
    });
    runtime.socketSessionName = sessionName;
    runtime.attachedClientKind = "";
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
        processServerOutput(event.data);
      } else {
        if (handleTerminalControlMessage(event.data)) return;
        processServerOutput(event.data);
      }
    });

    socket.addEventListener("error", () => {
      if (socket === runtime.socket) {
        setState("connectionStatus", "disconnected");
      }
    });

    socket.addEventListener("close", (event) => {
      if (socket !== runtime.socket) return;
      runtime.socketSessionName = "";
      runtime.attachedClientKind = "";
      runtime.trzszBridge?.stop();
      runtime.trzszBridge = null;
      if (socket._tmuxWebIntentionalClose) return;
      rejectTerminalControlRequests(new Error("terminal websocket closed"));
      const connectionMessage = runtime.inputQueueOverflow
        ? "Network congested. Reconnect to continue"
        : event.code ? `Connection closed (${event.code})` : "Connection closed";
      runtime.inputQueueOverflow = false;
      setState({
        connected: false,
        connectionStatus: "disconnected",
        reconnectPending: true,
        hasDisconnected: true,
        connectionMessage,
        connectionTransient: false,
      });
      focus();
    });
  }

  async function attachAfterResponsiveLayoutPrep(runId, sessionName, socket) {
    if (!isCurrentConnectionRun(runId, sessionName) || socket !== runtime.socket) return;
    fitTerminalViewport();
    const { cols, rows } = proposedSize();
    const clientKind = currentClientKind();
    const tmuxTheme = runtime.tmuxTheme || state.tmuxTheme || {};
    socket.send(JSON.stringify({
      type: "attach",
      cols,
      rows,
      client_kind: clientKind,
      pane_border_theme: tmuxThemeToWire(tmuxTheme),
    }));
    runtime.attachedClientKind = clientKind;
    runtime.lastTmuxThemeSignature = tmuxThemeSignature(tmuxTheme);
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
    void refreshWindows(sessionName);
    focus();
  }

  function close({ disposeTerminal = true, intentional = true } = {}) {
    runtime.connectionRunId += 1;
    clearQueuedTerminalInput();
    if (intentional) {
      runtime.inputQueueOverflow = false;
    }
    if (runtime.socket) {
      runtime.socket._tmuxWebIntentionalClose = intentional;
      runtime.socket.close();
    }
    runtime.trzszBridge?.stop();
    runtime.socket = null;
    runtime.trzszBridge = null;
    runtime.socketSessionName = "";
    runtime.attachedClientKind = "";
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
    if (runtime.clientActivityFrame) {
      window.cancelAnimationFrame(runtime.clientActivityFrame);
      runtime.clientActivityFrame = 0;
    }
    if (disposeTerminal && runtime.resizeObserver) {
      runtime.resizeObserver.disconnect();
      runtime.resizeObserver = null;
    }
    if (disposeTerminal && runtime.dragDropController) {
      runtime.dragDropController.abort();
      runtime.dragDropController = null;
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
      runtime.canvasAddon = null;
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
    runtime.trzszBridge?.stop();
    runtime.socket = null;
    runtime.trzszBridge = null;
    runtime.socketSessionName = "";
    runtime.attachedClientKind = "";
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
    if (runtime.trzszBridge) {
      runtime.trzszBridge.processTerminalInput(data);
    } else {
      sendTerminalInput(data);
    }
  }

  function sendBinaryInput(data) {
    if (!data) return;
    runtime.trzszBridge?.processBinaryInput(data);
  }

  function sendTerminalInput(data) {
    const socket = runtime.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    enqueueTerminalInput(data);
  }

  function enqueueTerminalInput(data) {
    const bytes = inputByteLength(data);
    if (runtime.pendingTerminalInputBytes + bytes > INPUT_QUEUE_MAX_BYTES) {
      failCongestedInput();
      return;
    }

    const pending = runtime.pendingTerminalInput;
    const previous = pending[pending.length - 1];
    if (typeof data === "string" && typeof previous === "string") {
      pending[pending.length - 1] = previous + data;
    } else {
      pending.push(data);
    }
    runtime.pendingTerminalInputBytes += bytes;
    scheduleTerminalInputFlush(INPUT_BATCH_WINDOW_MS);
  }

  function inputByteLength(data) {
    return typeof data === "string" ? inputTextEncoder.encode(data).byteLength : data.byteLength;
  }

  function scheduleTerminalInputFlush(delay) {
    if (runtime.inputFlushTimer) return;
    runtime.inputFlushTimer = window.setTimeout(() => {
      runtime.inputFlushTimer = 0;
      flushTerminalInput();
    }, delay);
  }

  function flushTerminalInput() {
    const socket = runtime.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      clearQueuedTerminalInput();
      return;
    }

    while (runtime.pendingTerminalInput.length > 0) {
      if (socket.bufferedAmount >= INPUT_BUFFERED_AMOUNT_HIGH_WATER_MARK) {
        scheduleTerminalInputFlush(INPUT_BACKPRESSURE_RETRY_MS);
        return;
      }

      const data = runtime.pendingTerminalInput.shift();
      runtime.pendingTerminalInputBytes -= inputByteLength(data);
      if (typeof data === "string") {
        socket.send(JSON.stringify({ type: "input", data }));
      } else {
        socket.send(data);
      }
    }
  }

  function clearQueuedTerminalInput() {
    clearTimeout(runtime.inputFlushTimer);
    runtime.inputFlushTimer = 0;
    runtime.pendingTerminalInput.length = 0;
    runtime.pendingTerminalInputBytes = 0;
  }

  function failCongestedInput() {
    const socket = runtime.socket;
    clearQueuedTerminalInput();
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    runtime.inputQueueOverflow = true;
    socket.close(1013, "terminal input queue exceeded limit");
  }

  function processServerOutput(data) {
    if (runtime.trzszBridge) {
      runtime.trzszBridge.processServerOutput(data);
    } else {
      writeToTerminal(data);
    }
  }

  function writeToTerminal(data) {
    const terminal = runtime.terminal;
    if (!terminal) return;
    if (typeof data === "string") {
      terminal.write(data);
    } else if (data instanceof Uint8Array) {
      terminal.write(data);
    } else if (data instanceof ArrayBuffer) {
      terminal.write(new Uint8Array(data));
    } else if (data instanceof Blob) {
      data.arrayBuffer().then((buffer) => {
        if (runtime.terminal === terminal) {
          terminal.write(new Uint8Array(buffer));
        }
      });
    }
  }

  function installTrzszDragDrop(element) {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    element.addEventListener("dragover", (event) => {
      if (!runtime.trzszBridge) return;
      event.preventDefault();
    }, options);
    element.addEventListener("drop", (event) => {
      const items = event.dataTransfer?.items;
      if (!runtime.trzszBridge || !items?.length) return;
      event.preventDefault();
      runtime.trzszBridge.uploadFiles(items).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        showTransientOverlay(message || "Upload failed", 1600);
      });
    }, options);
    return controller;
  }

  function sendClientActivity() {
    if (!runtime.socket || runtime.socket.readyState !== WebSocket.OPEN) return;
    if (!runtime.attachedClientKind) return;
    runtime.socket.send(JSON.stringify({ type: "client_activity" }));
  }

  function scheduleClientActivity() {
    if (runtime.clientActivityFrame) return;
    runtime.clientActivityFrame = window.requestAnimationFrame(() => {
      runtime.clientActivityFrame = 0;
      const now = performance.now();
      if (now - runtime.lastClientActivityAt < CLIENT_ACTIVITY_THROTTLE_MS) return;
      runtime.lastClientActivityAt = now;
      sendClientActivity();
    });
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
    runtime.trzszBridge?.setTerminalColumns(cols);
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

  function currentClientKind() {
    return isMobileViewport() ? "mobile" : "desktop";
  }

  function tmuxThemeToWire(theme) {
    return {
      pane_border_style: theme?.paneBorderStyle || null,
      pane_active_border_style: theme?.paneActiveBorderStyle || null,
    };
  }

  function tmuxThemeSignature(theme) {
    return JSON.stringify(tmuxThemeToWire(theme));
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
      && runtime.socketSessionName === sessionName
      && Boolean(runtime.attachedClientKind)
      && runtime.socket
      && runtime.socket.readyState === WebSocket.OPEN;
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

  async function listWindows(sessionName = state.activeSession) {
    if (!canUseTerminalControl(sessionName)) return [];
    const data: any = await sendTerminalControlRequest("list_windows");
    return Array.isArray(data.windows) ? data.windows : [];
  }

  async function refreshWindows(sessionName = state.activeSession) {
    if (!sessionName) {
      setState({ windows: [], activeWindowId: "" });
      return [];
    }
    if (sessionName !== state.activeSession || !canUseTerminalControl(sessionName)) {
      if (sessionName === state.activeSession) {
        setState({ windows: [], activeWindowId: "" });
      }
      return [];
    }
    try {
      const windows = await listWindows(sessionName);
      if (sessionName !== state.activeSession) return windows;
      const activeWindowId = windows.find((window) => window.active)?.id || windows[0]?.id || "";
      setState({ windows, activeWindowId });
      return windows;
    } catch (_) {
      if (sessionName === state.activeSession) {
        setState({ windows: [], activeWindowId: "" });
      }
      return [];
    }
  }

  async function createWindow(name, sessionName = state.activeSession) {
    if (!canUseTerminalControl(sessionName)) return null;
    const data: any = await sendTerminalControlRequest("create_window", { name });
    return data.window || null;
  }

  async function selectWindow(windowId, sessionName = state.activeSession) {
    if (!windowId || !canUseTerminalControl(sessionName)) return null;
    const data: any = await sendTerminalControlRequest("select_window", { window_id: windowId });
    return data.window || null;
  }

  async function killWindow(windowId, sessionName = state.activeSession) {
    if (!windowId || !canUseTerminalControl(sessionName)) return;
    await sendTerminalControlRequest("kill_window", { window_id: windowId });
  }

  async function clearResponsiveWindowZoomed(sessionName) {
    if (!canUseTerminalControl(sessionName)) {
      throw new Error("terminal websocket is not connected");
    }
    await sendTerminalControlRequest("clear_auto_zoom");
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
    alignTerminalScreenBottom();
    logTerminalMetricsOnce();
  }

  function alignTerminalScreenBottom() {
    const terminalElement = runtime.terminalElement;
    if (!terminalElement) return;

    terminalElement.style.setProperty("--terminal-screen-offset", "0px");
    const viewport = terminalElement.querySelector(".xterm-viewport");
    const screen = terminalElement.querySelector(".xterm-screen");
    if (!viewport || !screen) return;

    const viewportRect = viewport.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    if (viewportRect.height <= 0 || screenRect.height <= 0) return;

    const offset = Math.max(0, viewportRect.bottom - screenRect.bottom);
    terminalElement.style.setProperty("--terminal-screen-offset", `${Math.round(offset)}px`);
  }

  function logTerminalMetricsOnce() {
    if (!import.meta.env.DEV || runtime.terminalMetricsLogged) return;
    if (!shouldLogTerminalMetrics()) return;
    const terminalElement = runtime.terminalElement;
    const terminal = runtime.terminal;
    if (!terminalElement || !terminal || terminal.cols <= 0 || terminal.rows <= 0) return;

    const screen = terminalElement.querySelector(".xterm-screen");
    if (!screen) return;

    const screenRect = screen.getBoundingClientRect();
    if (screenRect.width <= 0 || screenRect.height <= 0) return;

    runtime.terminalMetricsLogged = true;
    console.debug("[tmux-web] terminal metrics", {
      cols: terminal.cols,
      rows: terminal.rows,
      screenWidth: screenRect.width,
      screenHeight: screenRect.height,
      cellWidth: screenRect.width / terminal.cols,
      cellHeight: screenRect.height / terminal.rows,
      devicePixelRatio: window.devicePixelRatio,
    });
  }

  function shouldLogTerminalMetrics() {
    try {
      return window.localStorage.getItem(TERMINAL_METRICS_DEBUG_KEY) === "1";
    } catch (_) {
      return false;
    }
  }

  function fitAndResize() {
    if (!runtime.fitAddon || !runtime.terminal) return;
    fitTerminalViewport();
    clearTimeout(runtime.resizeTimer);
    runtime.resizeTimer = window.setTimeout(() => {
      const { cols, rows } = proposedSize();
      sendResize(cols, rows);
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

  function handleViewportChange() {
    if (shouldReconnectForClientKindChange()) {
      restartConnectionForClientKindChange();
    }
    requestFit({ settle: true });
  }

  function handlePageActivation() {
    if (shouldReconnectForClientKindChange()) {
      restartConnectionForClientKindChange();
      return;
    }
    if (isRecentPointerActivation()) return;
    scheduleClientActivity();
  }

  function notePointerActivation() {
    runtime.lastPointerActivationAt = performance.now();
    scheduleClientActivity();
  }

  function isRecentPointerActivation() {
    return performance.now() - runtime.lastPointerActivationAt < POINTER_ACTIVATION_SUPPRESS_MS;
  }

  function shouldReconnectForClientKindChange() {
    if (!state.activeSession || !runtime.terminal || !runtime.attachedClientKind) return false;
    if (!runtime.socket || runtime.socket.readyState !== WebSocket.OPEN) return false;
    return runtime.attachedClientKind !== currentClientKind();
  }

  function restartConnectionForClientKindChange() {
    if (!state.activeSession || !runtime.terminal) return;
    if (runtime.socket) {
      runtime.socket._tmuxWebIntentionalClose = true;
      runtime.socket.close();
    }
    runtime.trzszBridge?.stop();
    runtime.socket = null;
    runtime.trzszBridge = null;
    runtime.socketSessionName = "";
    runtime.attachedClientKind = "";
    rejectTerminalControlRequests(new Error("terminal websocket reconnecting"));
    setState({
      connected: false,
      reconnectPending: false,
      connectionStatus: "reconnecting",
      connectionMessage: "",
      connectionTransient: false,
    });
    beginConnection(state.activeSession);
  }

  function applyTheme(theme) {
    if (runtime.terminal) {
      runtime.terminal.options.theme = theme || {};
    }
  }

  function applyTmuxTheme(theme) {
    runtime.tmuxTheme = theme || {};
    sendTmuxTheme();
  }

  function sendTmuxTheme() {
    if (!runtime.socket || runtime.socket.readyState !== WebSocket.OPEN) return;
    if (!runtime.attachedClientKind) return;

    const theme = runtime.tmuxTheme || {};
    const signature = tmuxThemeSignature(theme);
    if (signature === runtime.lastTmuxThemeSignature) return;
    runtime.lastTmuxThemeSignature = signature;
    runtime.socket.send(JSON.stringify({
      type: "set_pane_border_theme",
      pane_border_theme: tmuxThemeToWire(theme),
    }));
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
  }

  function dropPaneCache(sessionName) {
    runtime.panesBySession.delete(sessionName);
  }

  function noteManualPaneZoom(sessionName = state.activeSession) {
    if (!sessionName) return;
    void clearResponsiveWindowZoomed(sessionName).catch(() => {});
  }

  return {
    applyTheme,
    applyTmuxTheme,
    close,
    createWindow,
    dropPaneCache,
    focus,
    handlePageActivation,
    handleViewportChange,
    mount,
    notePointerActivation,
    noteManualPaneZoom,
    killWindow,
    listWindows,
    listWindowPanes,
    reconnect,
    retainPaneCacheForSessions,
    requestFit,
    refreshWindows,
    schedulePaneLayoutRefresh,
    sendInput,
    selectWindow,
    selectWindowPane,
    sync,
    unmount,
  };
}
