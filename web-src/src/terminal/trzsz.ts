import { TrzszFilter } from "trzsz";

const TRANSFER_SOCKET_CLOSE_DELAY_MS = 500;
const TRANSFER_SOCKET_QUEUE_LIMIT = 512;

type TrzszBridgeOptions = {
  transferId: string;
  writeToTerminal: (data: string | ArrayBuffer | Uint8Array | Blob) => void;
  sendTerminalInput: (data: string | Uint8Array) => void;
  showMessage: (message: string, timeout?: number) => void;
  getTerminalColumns: () => number;
};

export function createTrzszBridge({
  transferId,
  writeToTerminal,
  sendTerminalInput,
  showMessage,
  getTerminalColumns,
}: TrzszBridgeOptions) {
  installDownloadFallbackPicker();

  let transferSocket: WebSocket | null = null;
  let transferQueue: ArrayBuffer[] = [];
  let transferCloseTimer = 0;

  const filter = new TrzszFilter({
    writeToTerminal,
    sendToServer: sendFilterData,
    terminalColumns: getTerminalColumns() || 80,
  });

  function processServerOutput(data: string | ArrayBuffer | Uint8Array | Blob) {
    filter.processServerOutput(data);
    scheduleTransferSocketClose();
  }

  function processTerminalInput(data: string) {
    if (filter.isTransferringFiles()) {
      filter.processTerminalInput(data);
    } else {
      sendTerminalInput(data);
    }
  }

  function processBinaryInput(data: string) {
    if (filter.isTransferringFiles()) {
      filter.processBinaryInput(data);
    } else {
      sendTerminalInput(stringToByteArray(data));
    }
  }

  function uploadFiles(items: DataTransferItemList) {
    return filter.uploadFiles(items);
  }

  function setTerminalColumns(columns: number) {
    filter.setTerminalColumns(columns);
  }

  function isTransferringFiles() {
    return filter.isTransferringFiles();
  }

  function stop() {
    try {
      if (filter.isTransferringFiles()) {
        filter.stopTransferringFiles();
      }
    } catch (_) {}
    closeTransferSocket();
  }

  function sendFilterData(data: string | Uint8Array) {
    if (filter.isTransferringFiles()) {
      sendTransferData(data);
      return;
    }
    sendTerminalInput(data);
  }

  function sendTransferData(data: string | Uint8Array) {
    const payload = transferPayload(data);
    const socket = ensureTransferSocket();
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
      scheduleTransferSocketClose();
      return;
    }

    if (transferQueue.length >= TRANSFER_SOCKET_QUEUE_LIMIT) {
      showMessage("trzsz transfer queue is full", 1600);
      stop();
      return;
    }
    transferQueue.push(payload);
  }

  function ensureTransferSocket() {
    if (
      transferSocket
      && (transferSocket.readyState === WebSocket.OPEN
        || transferSocket.readyState === WebSocket.CONNECTING)
    ) {
      return transferSocket;
    }

    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams({ id: transferId });
    transferSocket = new WebSocket(`${protocol}://${location.host}/ws/trzsz?${params}`);
    transferSocket.binaryType = "arraybuffer";

    transferSocket.addEventListener("open", () => flushTransferQueue());
    transferSocket.addEventListener("close", () => {
      transferSocket = null;
      transferQueue = [];
    });
    transferSocket.addEventListener("error", () => {
      showMessage("trzsz transfer connection failed", 1600);
    });

    return transferSocket;
  }

  function flushTransferQueue() {
    const socket = transferSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (transferQueue.length > 0) {
      socket.send(transferQueue.shift()!);
    }
    scheduleTransferSocketClose();
  }

  function scheduleTransferSocketClose() {
    window.clearTimeout(transferCloseTimer);
    transferCloseTimer = window.setTimeout(() => {
      if (filter.isTransferringFiles() || transferQueue.length > 0) {
        scheduleTransferSocketClose();
        return;
      }
      closeTransferSocket();
    }, TRANSFER_SOCKET_CLOSE_DELAY_MS);
  }

  function closeTransferSocket() {
    window.clearTimeout(transferCloseTimer);
    transferCloseTimer = 0;
    transferQueue = [];
    if (transferSocket) {
      transferSocket.close();
      transferSocket = null;
    }
  }

  return {
    isTransferringFiles,
    processBinaryInput,
    processServerOutput,
    processTerminalInput,
    setTerminalColumns,
    stop,
    uploadFiles,
  };
}

export function generateTransferId() {
  const browserCrypto = globalThis.crypto;
  if (browserCrypto?.randomUUID) {
    return browserCrypto.randomUUID();
  }
  if (browserCrypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    browserCrypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

function transferPayload(data: string | Uint8Array) {
  const bytes = typeof data === "string" ? stringToByteArray(data) : data;
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
  return payload.buffer as ArrayBuffer;
}

function installDownloadFallbackPicker() {
  const win = window as any;
  if (win.__tmuxWebTrzszDownloadFallbackInstalled) return;

  const nativeShowDirectoryPicker = typeof win.showDirectoryPicker === "function"
    ? win.showDirectoryPicker.bind(window)
    : null;
  if (nativeShowDirectoryPicker && canUseFileSystemAccessApi()) return;

  win.__tmuxWebTrzszDownloadFallbackInstalled = true;
  Object.defineProperty(window, "showDirectoryPicker", {
    configurable: true,
    value: async (options?: { id?: string }) => {
      if (options?.id === "trzsz_download") {
        return new DownloadDirectoryHandle("Downloads");
      }
      if (nativeShowDirectoryPicker) {
        return nativeShowDirectoryPicker(options);
      }
      throw new Error("The File System Access API requires HTTPS except localhost");
    },
  });
}

function canUseFileSystemAccessApi() {
  return location.protocol === "https:"
    || ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
}

class DownloadDirectoryHandle {
  readonly kind = "directory";
  readonly entries = new Map<string, DownloadDirectoryHandle | DownloadFileHandle>();

  constructor(
    readonly name: string,
    private readonly path: string[] = [name],
  ) {}

  async *values() {
    for (const entry of this.entries.values()) {
      yield entry;
    }
  }

  async getFileHandle(name: string, _options?: { create?: boolean }) {
    const handle = new DownloadFileHandle(name, [...this.path, name]);
    this.entries.set(name, handle);
    return handle;
  }

  async getDirectoryHandle(name: string, _options?: { create?: boolean }) {
    const existing = this.entries.get(name);
    if (existing instanceof DownloadDirectoryHandle) return existing;
    const handle = new DownloadDirectoryHandle(name, [...this.path, name]);
    this.entries.set(name, handle);
    return handle;
  }
}

class DownloadFileHandle {
  readonly kind = "file";

  constructor(
    readonly name: string,
    private readonly path: string[],
  ) {}

  async createWritable() {
    return new BrowserDownloadWriter(downloadName(this.path));
  }
}

class BrowserDownloadWriter {
  private chunks: BlobPart[] = [];
  private closed = false;

  constructor(private readonly fileName: string) {}

  async write(chunk: FileSystemWriteChunkType) {
    if (this.closed) return;
    if (typeof chunk === "string" || chunk instanceof Blob || chunk instanceof ArrayBuffer) {
      this.chunks.push(chunk);
      return;
    }
    if (ArrayBuffer.isView(chunk)) {
      this.chunks.push(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
      return;
    }
    if (typeof chunk === "object" && chunk && "data" in chunk) {
      await this.write(chunk.data as FileSystemWriteChunkType);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const blob = new Blob(this.chunks);
    this.chunks = [];
    triggerBrowserDownload(blob, this.fileName);
  }
}

function downloadName(path: string[]) {
  const relativePath = path.slice(1).filter(Boolean);
  const name = relativePath.length ? relativePath.join("__") : path[path.length - 1];
  return name.replace(/[\0\r\n]/g, "_") || "download";
}

function triggerBrowserDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function stringToByteArray(data: string) {
  const bytes = new Uint8Array(data.length);
  for (let idx = 0; idx < data.length; idx += 1) {
    bytes[idx] = data.charCodeAt(idx) & 0xff;
  }
  return bytes;
}
