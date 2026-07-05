import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { createActions } from "./actions";
import { installContextMenuSuppression, installViewportSizeSync } from "./browser";
import LoginView from "./components/LoginView";
import Workspace from "./components/Workspace";
import { createInitialState } from "./state";
import { createTerminalController } from "./terminal/controller";
import {
  applyResolvedThemeToDocument,
  resolveTheme,
  terminalThemeFromDocument,
  tmuxThemeFromDocument,
  type ColorScheme,
} from "./terminal/themes";

export default function App() {
  const [state, setState] = createStore(createInitialState());
  const [systemColorScheme, setSystemColorScheme] = createSignal(currentSystemColorScheme());
  let terminal;
  const actions = createActions({
    state,
    setState,
    getTerminal: () => terminal,
  });

  terminal = createTerminalController({
    state,
    setState,
    applyStickyModifiers: actions.applyStickyModifiers,
    handleTerminalKeyEvent: actions.handleTerminalKeyEvent,
    onAuthExpired: actions.handleAuthExpired,
  });

  const cleanup = [];

  createEffect(() => {
    const root = document.documentElement;
    const theme = resolveTheme(
      state.themePreference,
      state.themeConfig,
      systemColorScheme(),
    );
    applyResolvedThemeToDocument(root, theme);
    const terminalTheme = terminalThemeFromDocument(root, theme);
    const tmuxTheme = tmuxThemeFromDocument(root, theme);
    setState({
      resolvedTheme: theme.resolvedTheme,
      colorScheme: theme.colorScheme,
      uiTheme: theme.ui,
      terminalTheme,
      tmuxTheme,
    });
    terminal.applyTheme(terminalTheme);
    terminal.applyTmuxTheme(tmuxTheme);
  });

  onMount(() => {
    cleanup.push(installSystemThemeSync(setSystemColorScheme));
    cleanup.push(installViewportSizeSync(() => terminal.handleViewportChange()));
    cleanup.push(installContextMenuSuppression());
    window.addEventListener("keydown", actions.handleGlobalKeyEvent, true);
    window.addEventListener("pointerdown", terminal.notePointerActivation, true);
    window.addEventListener("focus", terminal.handlePageActivation);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    void actions.bootstrap().catch((error) => {
      setState("bootError", error.message);
    });
  });

  onCleanup(() => {
    cleanup.forEach((dispose) => dispose());
    window.removeEventListener("keydown", actions.handleGlobalKeyEvent, true);
    window.removeEventListener("pointerdown", terminal.notePointerActivation, true);
    window.removeEventListener("focus", terminal.handlePageActivation);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    terminal.close({ disposeTerminal: true, intentional: true });
  });

  function handleVisibilityChange() {
    if (document.visibilityState === "visible") {
      terminal.handlePageActivation();
    }
  }

  return (
    <Show
      when={state.authenticated}
      fallback={<LoginView state={state} actions={actions} />}
    >
      <Workspace state={state} actions={actions} terminal={terminal} />
    </Show>
  );
}

function currentSystemColorScheme(): ColorScheme {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function installSystemThemeSync(setSystemColorScheme: (scheme: ColorScheme) => void) {
  const media = window.matchMedia?.("(prefers-color-scheme: light)");
  if (!media) return () => {};

  const handleChange = () => {
    setSystemColorScheme(media.matches ? "light" : "dark");
  };
  media.addEventListener("change", handleChange);
  handleChange();
  return () => media.removeEventListener("change", handleChange);
}
