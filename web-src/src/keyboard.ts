import { DEFAULT_STICKY_MODIFIERS } from "./state";

export const STICKY_KEYS = [
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

export function emptyStickyModifiers() {
  return { ...DEFAULT_STICKY_MODIFIERS };
}

export function hasStickyModifiers(modifiers) {
  return Boolean(modifiers.ctrl || modifiers.alt || modifiers.shift);
}

export function applyStickyModifiersToInput(data, modifiers) {
  if (!hasStickyModifiers(modifiers) || data.length === 0) {
    return { data, consumed: false };
  }

  const first = data[0];
  let transformed = first;
  if (modifiers.shift && isAsciiLetter(transformed)) {
    transformed = transformed.toUpperCase();
  }
  if (modifiers.ctrl) {
    transformed = ctrlTransform(transformed);
  }
  if (modifiers.alt) {
    transformed = `\x1b${transformed}`;
  }

  return { data: `${transformed}${data.slice(1)}`, consumed: true };
}

export function composeSpecialKey(id, modifiers) {
  const final = { up: "A", down: "B", right: "C", left: "D" }[id];
  if (!final) return { data: "", consumed: false };
  if (!hasStickyModifiers(modifiers)) {
    return { data: `\x1b[${final}`, consumed: false };
  }

  const code = 1
    + (modifiers.shift ? 1 : 0)
    + (modifiers.alt ? 2 : 0)
    + (modifiers.ctrl ? 4 : 0);
  return { data: `\x1b[1;${code}${final}`, consumed: true };
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
