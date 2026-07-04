export function createControlClient() {
  const runtime = {
    socket: null,
    opening: null,
    requests: new Map(),
    nextRequestId: 1,
    intentionalClose: false,
  };

  async function request(type, payload = {}) {
    const socket = await connect();
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("control websocket is not connected");
    }

    const requestId = String(runtime.nextRequestId++);
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        runtime.requests.delete(requestId);
        reject(new Error("control websocket request timed out"));
      }, 8000);
      runtime.requests.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({
        type,
        request_id: requestId,
        ...payload,
      }));
    });
  }

  function connect() {
    const socket = runtime.socket;
    if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
    if (runtime.opening) return runtime.opening;

    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const nextSocket = new WebSocket(`${protocol}://${location.host}/ws/control`);
    runtime.socket = nextSocket;
    runtime.intentionalClose = false;

    runtime.opening = new Promise((resolve, reject) => {
      const clearOpening = () => {
        if (runtime.opening) runtime.opening = null;
      };
      nextSocket.addEventListener("open", () => {
        clearOpening();
        resolve(nextSocket);
      }, { once: true });
      nextSocket.addEventListener("error", () => {
        clearOpening();
        reject(new Error("control websocket failed"));
      }, { once: true });
      nextSocket.addEventListener("close", () => {
        clearOpening();
        if (runtime.socket === nextSocket) runtime.socket = null;
        rejectOpenOrPending(new Error("control websocket closed"));
      }, { once: true });
      nextSocket.addEventListener("message", (event) => {
        handleMessage(event.data);
      });
    });

    return runtime.opening;
  }

  function handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch (_) {
      return;
    }
    if (message?.type !== "control_response" || !message.request_id) return;

    const pending = runtime.requests.get(message.request_id);
    if (!pending) return;
    runtime.requests.delete(message.request_id);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve(message.data || {});
    } else {
      pending.reject(new Error(message.error || "control websocket request failed"));
    }
  }

  function rejectOpenOrPending(error) {
    for (const pending of runtime.requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    runtime.requests.clear();
  }

  function close() {
    runtime.intentionalClose = true;
    if (runtime.socket) runtime.socket.close();
    runtime.socket = null;
    rejectOpenOrPending(new Error("control websocket closed"));
  }

  async function listWindows(sessionName) {
    const data: any = await request("list_windows", { session_name: sessionName });
    return Array.isArray(data.windows) ? data.windows : [];
  }

  async function createWindow(sessionName, name) {
    const data: any = await request("create_window", { session_name: sessionName, name });
    return data.window || null;
  }

  async function selectWindow(sessionName, windowId) {
    const data: any = await request("select_window", {
      session_name: sessionName,
      window_id: windowId,
    });
    return data.window || null;
  }

  async function killWindow(sessionName, windowId) {
    await request("kill_window", {
      session_name: sessionName,
      window_id: windowId,
    });
  }

  return {
    close,
    createWindow,
    killWindow,
    listWindows,
    request,
    selectWindow,
  };
}
