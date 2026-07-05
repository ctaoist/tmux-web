import "../../styles/theme.css";

export type ColorScheme = "dark" | "light";
export type UiTheme = Record<string, string>;
export type TerminalTheme = Record<string, string | string[]>;
export type TmuxTheme = {
  paneBorderStyle?: string;
  paneActiveBorderStyle?: string;
};
export type ThemeConfig = {
  theme?: string;
  [name: string]: unknown;
};

export type ResolvedTheme = {
  preference: string;
  resolvedTheme: string;
  colorScheme: ColorScheme;
  ui: UiTheme;
  terminal: TerminalTheme;
  tmux: TmuxTheme;
};

const UI_THEME_VARIABLES = [
  "--bg",
  "--panel",
  "--panel-2",
  "--panel-active",
  "--line",
  "--line-soft",
  "--text",
  "--muted",
  "--amber",
  "--cyan",
  "--green",
  "--red",
  "--shadow",
  "--login-grid-primary",
  "--login-grid-secondary",
  "--login-panel-bg",
  "--input-bg",
  "--primary-border",
  "--primary-bg",
  "--terminal-bg",
  "--danger-bg",
  "--danger-panel-bg",
  "--danger-border",
  "--connection-border",
  "--connection-bg",
  "--tmux-pane-border-style",
  "--tmux-pane-active-border-style",
  "--cyan-border",
  "--cyan-bg",
  "--command-bar-bg",
  "--key-bg",
  "--key-border-bottom",
  "--modal-bg",
  "--submenu-bg",
  "--submenu-hover-bg",
  "--command-item-bg",
  "--command-item-border",
  "--command-item-hover-bg",
  "--command-item-hover-border",
  "--command-item-active-bg",
  "--command-item-active-border",
  "--command-key-bg",
  "--command-key-border",
  "--command-key-text",
];

const TERMINAL_THEME_VARIABLES = {
  background: "--xterm-background",
  foreground: "--xterm-foreground",
  cursor: "--xterm-cursor",
  selectionBackground: "--xterm-selection-background",
  black: "--xterm-black",
  red: "--xterm-red",
  green: "--xterm-green",
  yellow: "--xterm-yellow",
  blue: "--xterm-blue",
  magenta: "--xterm-magenta",
  cyan: "--xterm-cyan",
  white: "--xterm-white",
  brightBlack: "--xterm-bright-black",
  brightRed: "--xterm-bright-red",
  brightGreen: "--xterm-bright-green",
  brightYellow: "--xterm-bright-yellow",
  brightBlue: "--xterm-bright-blue",
  brightMagenta: "--xterm-bright-magenta",
  brightCyan: "--xterm-bright-cyan",
  brightWhite: "--xterm-bright-white",
};

const TMUX_THEME_VARIABLES = {
  paneBorderStyle: "--tmux-pane-border-style",
  paneActiveBorderStyle: "--tmux-pane-active-border-style",
};

const appliedUiVariables = new WeakMap<HTMLElement, Set<string>>();

export function normalizeThemePreference(config: ThemeConfig = {}): string {
  const preference = typeof config.theme === "string" ? config.theme.trim() : "";
  return preference || "auto";
}

export function resolveTheme(
  preference: string,
  config: ThemeConfig = {},
  systemColorScheme: ColorScheme,
): ResolvedTheme {
  if (preference === "auto") {
    return resolveBuiltinTheme(preference, systemColorScheme, config);
  }

  if (isColorScheme(preference)) {
    return resolveBuiltinTheme(preference, preference, config);
  }

  const custom = themeDefinition(config, preference);
  return {
    preference,
    resolvedTheme: preference,
    colorScheme: inferColorScheme(preference, custom.ui, custom.terminal),
    ui: custom.ui,
    terminal: custom.terminal,
    tmux: custom.tmux,
  };
}

export function applyResolvedThemeToDocument(root: HTMLElement, theme: ResolvedTheme) {
  root.dataset.theme = theme.resolvedTheme;
  root.style.setProperty("color-scheme", theme.colorScheme);
  const previousVariables = appliedUiVariables.get(root) || new Set<string>();
  for (const variable of new Set([...UI_THEME_VARIABLES, ...previousVariables])) {
    root.style.removeProperty(variable);
  }
  const nextVariables = new Set<string>();
  for (const [variable, value] of Object.entries(theme.ui)) {
    if (variable.startsWith("--")) {
      root.style.setProperty(variable, value);
      nextVariables.add(variable);
    }
  }
  appliedUiVariables.set(root, nextVariables);
}

export function terminalThemeFromDocument(root: HTMLElement, theme: ResolvedTheme): TerminalTheme {
  if (!isColorScheme(theme.resolvedTheme)) {
    return theme.terminal;
  }

  return {
    ...readTerminalThemeVariables(root),
    ...theme.terminal,
  };
}

export function tmuxThemeFromDocument(root: HTMLElement, theme: ResolvedTheme): TmuxTheme {
  return {
    ...readTmuxThemeVariables(root),
    ...theme.tmux,
  };
}

function resolveBuiltinTheme(
  preference: string,
  resolvedTheme: ColorScheme,
  config: ThemeConfig,
): ResolvedTheme {
  const override = themeDefinition(config, resolvedTheme);
  return {
    preference,
    resolvedTheme,
    colorScheme: resolvedTheme,
    ui: override.ui,
    terminal: override.terminal,
    tmux: override.tmux,
  };
}

function readTerminalThemeVariables(root: HTMLElement): TerminalTheme {
  const styles = getComputedStyle(root);
  const theme: TerminalTheme = {};

  for (const [key, variable] of Object.entries(TERMINAL_THEME_VARIABLES)) {
    const value = styles.getPropertyValue(variable).trim();
    if (value) {
      theme[key] = value;
    }
  }

  return theme;
}

function readTmuxThemeVariables(root: HTMLElement): TmuxTheme {
  const styles = getComputedStyle(root);
  const theme: TmuxTheme = {};

  for (const [key, variable] of Object.entries(TMUX_THEME_VARIABLES)) {
    const value = styles.getPropertyValue(variable).trim();
    if (value) {
      theme[key] = value;
    }
  }

  return theme;
}

function themeDefinition(config: ThemeConfig, name: string) {
  const value = config?.[name];
  if (!isPlainObject(value)) {
    return { ui: {}, terminal: {}, tmux: {} };
  }
  return {
    ui: sanitizeUiTheme(value.ui),
    terminal: sanitizeTerminalTheme(value.terminal),
    tmux: sanitizeTmuxTheme(value.tmux),
  };
}

function sanitizeUiTheme(value: unknown): UiTheme {
  if (!isPlainObject(value)) return {};
  const theme: UiTheme = {};
  for (const [key, color] of Object.entries(value)) {
    if (key.startsWith("--") && typeof color === "string") {
      theme[key] = color;
    }
  }
  return theme;
}

function sanitizeTerminalTheme(value: unknown): TerminalTheme {
  if (!isPlainObject(value)) return {};
  const theme: TerminalTheme = {};
  for (const [key, color] of Object.entries(value)) {
    if (typeof color === "string") {
      theme[key] = color;
    } else if (Array.isArray(color) && color.every((item) => typeof item === "string")) {
      theme[key] = [...color];
    }
  }
  return theme;
}

function sanitizeTmuxTheme(value: unknown): TmuxTheme {
  if (!isPlainObject(value)) return {};
  const theme: TmuxTheme = {};
  if (typeof value.paneBorderStyle === "string") {
    theme.paneBorderStyle = value.paneBorderStyle;
  }
  if (typeof value.paneActiveBorderStyle === "string") {
    theme.paneActiveBorderStyle = value.paneActiveBorderStyle;
  }
  return theme;
}

function inferColorScheme(
  name: string,
  uiTheme: UiTheme,
  terminalTheme: TerminalTheme,
): ColorScheme {
  if (name === "light") return "light";
  if (name === "dark") return "dark";
  const background = uiTheme["--bg"] || terminalTheme.background;
  return typeof background === "string" && isLightColor(background) ? "light" : "dark";
}

function isColorScheme(value: string): value is ColorScheme {
  return value === "dark" || value === "light";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLightColor(color: string): boolean {
  const hex = color.trim().match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!hex) return false;
  const red = parseInt(hex.slice(0, 2), 16) / 255;
  const green = parseInt(hex.slice(2, 4), 16) / 255;
  const blue = parseInt(hex.slice(4, 6), 16) / 255;
  return 0.2126 * linearRgb(red) + 0.7152 * linearRgb(green) + 0.0722 * linearRgb(blue) > 0.5;
}

function linearRgb(channel: number): number {
  return channel <= 0.03928
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);
}
