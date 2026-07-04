import { createEffect, onCleanup, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { createActions } from "./actions";
import { installContextMenuSuppression, installViewportSizeSync } from "./browser";
import LoginView from "./components/LoginView";
import Workspace from "./components/Workspace";
import { createInitialState } from "./state";
import { createTerminalController } from "./terminal/controller";

export default function App() {
  const [state, setState] = createStore(createInitialState());
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
    document.documentElement.dataset.theme = state.theme;
    terminal.applyTheme(state.theme);
  });

  onMount(() => {
    cleanup.push(installViewportSizeSync(() => terminal.handleViewportChange()));
    cleanup.push(installContextMenuSuppression());
    window.addEventListener("keydown", actions.handleGlobalKeyEvent, true);
    window.addEventListener("pointerdown", terminal.handlePageActivation, true);
    window.addEventListener("focus", terminal.handlePageActivation);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    void actions.bootstrap().catch((error) => {
      setState("bootError", error.message);
    });
  });

  onCleanup(() => {
    cleanup.forEach((dispose) => dispose());
    window.removeEventListener("keydown", actions.handleGlobalKeyEvent, true);
    window.removeEventListener("pointerdown", terminal.handlePageActivation, true);
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
