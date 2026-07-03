export function installTerminalSelectionCopy({
  terminalElement,
  getTerminal,
  getActiveSession,
  getCachedPanes,
  refreshPaneLayout,
  focusTerminal,
}) {
  const controller = new AbortController();
  let dragSelection = null;
  let pendingSelectionCopy = null;
  const signal = controller.signal;

  terminalElement.addEventListener(
    "mousedown",
    (event) => {
      const terminal = getTerminal();
      const activeSession = getActiveSession();
      if (event.button !== 0 || !terminal || !activeSession) {
        dragSelection = null;
        return;
      }

      const sessionName = activeSession;
      terminal.clearSelection();
      dragSelection = {
        sessionName,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startCell: eventToTerminalCell(event, terminalElement, terminal),
        startBufferCell: eventToTerminalBufferCell(event, terminalElement, terminal),
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
      const terminal = getTerminal();
      if (!dragSelection || !terminal) return;
      if (Math.hypot(event.clientX - dragSelection.startClientX, event.clientY - dragSelection.startClientY) >= 4) {
        dragSelection.moved = true;
      }
      dragSelection.endBufferCell = eventToTerminalBufferCell(event, terminalElement, terminal)
        || dragSelection.endBufferCell;
    },
    { capture: true, signal },
  );

  document.addEventListener(
    "mouseup",
    (event) => {
      const terminal = getTerminal();
      if (!dragSelection || event.button !== 0 || !terminal) return;
      if (Math.hypot(event.clientX - dragSelection.startClientX, event.clientY - dragSelection.startClientY) >= 4) {
        dragSelection.moved = true;
      }
      dragSelection.endBufferCell = eventToTerminalBufferCell(event, terminalElement, terminal)
        || dragSelection.endBufferCell;
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
      copyPaneSelectionToClipboard(selection, {
        getTerminal,
        getActiveSession,
        getCachedPanes,
        focusTerminal,
      });
    },
    { signal },
  );

  const selectionDisposable = getTerminal()?.onSelectionChange(() => {
    if (!pendingSelectionCopy) return;
    const selection = pendingSelectionCopy;
    pendingSelectionCopy = null;
    copyPaneSelectionToClipboard(selection, {
      getTerminal,
      getActiveSession,
      getCachedPanes,
      focusTerminal,
    });
  });
  signal.addEventListener("abort", () => selectionDisposable?.dispose(), { once: true });

  return controller;
}

function copyPaneSelectionToClipboard(selection, context) {
  const terminal = context.getTerminal();
  if (!terminal || context.getActiveSession() !== selection.sessionName) return;
  if (!selection.startCell) return;

  const panes = selection.panes?.length
    ? selection.panes
    : context.getCachedPanes(selection.sessionName);
  const pane = panes.length
    ? findPaneContainingCell(selection.startCell, panes)
    : fallbackTerminalPane(terminal);
  if (!pane) return;

  const range = terminal.getSelectionPosition() || pointerSelectionRange(selection);
  if (!range) return;

  const text = buildPaneSelectionText(terminal, range, pane, selection.columnMode);
  if (!text) return;

  writeClipboardText(text, context.focusTerminal);
}

function eventToTerminalCell(event, terminalElement, terminal) {
  const screen = terminalElement.querySelector(".xterm-screen");
  if (!screen) return null;

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

function eventToTerminalBufferCell(event, terminalElement, terminal) {
  const cell = eventToTerminalCell(event, terminalElement, terminal);
  const viewportY = terminal?.buffer?.active?.viewportY;
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

function fallbackTerminalPane(terminal) {
  return {
    id: "terminal",
    left: 0,
    top: 0,
    width: terminal.cols,
    height: terminal.rows,
    active: true,
  };
}

function buildPaneSelectionText(terminal, range, pane, columnMode) {
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
    appendClippedBufferLine(
      rows,
      buffer,
      row,
      Math.max(selectedStartCol, paneLeft),
      Math.min(selectedEndCol, paneRight),
      false,
    );
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
    appendClippedBufferLine(
      rows,
      buffer,
      row,
      Math.max(selectedStartCol, paneLeft),
      Math.min(selectedEndCol, paneRight),
      true,
    );
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

function writeClipboardText(text, focusTerminal) {
  const copiedWithFallback = copyTextWithExecCommand(text, focusTerminal);
  if (!navigator.clipboard?.writeText) return copiedWithFallback;
  try {
    void navigator.clipboard.writeText(text).catch(() => {});
    return true;
  } catch (_) {
    return copiedWithFallback;
  }
}

function copyTextWithExecCommand(text, focusTerminal) {
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
  focusTerminal();
  return copied;
}

function isMacLike() {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || "");
}

function isWindowsLike() {
  return /Win/.test(navigator.platform || "");
}
