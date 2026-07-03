export function installTerminalTouchScroll(terminalElement) {
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

  return controller;
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
