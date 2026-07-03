const BROWSER_CONTEXT_MENU_EVENTS = [
  "contextmenu",
  "mousedown",
  "mouseup",
  "auxclick",
  "pointerdown",
  "pointerup",
];

export function installViewportSizeSync(onChange) {
  const sync = () => {
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    document.documentElement.style.setProperty("--viewport-left", `${Math.round(left)}px`);
    document.documentElement.style.setProperty("--viewport-top", `${Math.round(top)}px`);
    document.documentElement.style.setProperty("--viewport-width", `${Math.round(width)}px`);
    document.documentElement.style.setProperty("--viewport-height", `${Math.round(height)}px`);
    onChange?.();
  };

  sync();
  window.addEventListener("resize", sync);
  window.visualViewport?.addEventListener("resize", sync);
  window.visualViewport?.addEventListener("scroll", sync);

  return () => {
    window.removeEventListener("resize", sync);
    window.visualViewport?.removeEventListener("resize", sync);
    window.visualViewport?.removeEventListener("scroll", sync);
  };
}

export function installContextMenuSuppression() {
  BROWSER_CONTEXT_MENU_EVENTS.forEach((eventType) => {
    window.addEventListener(eventType, suppressBrowserContextMenu, { capture: true, passive: false });
  });

  return () => {
    BROWSER_CONTEXT_MENU_EVENTS.forEach((eventType) => {
      window.removeEventListener(eventType, suppressBrowserContextMenu, { capture: true });
    });
  };
}

export function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
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
