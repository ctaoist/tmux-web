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
    cleanup.push(installViewportSizeSync(() => terminal.requestFit()));
    cleanup.push(installContextMenuSuppression());
    window.addEventListener("keydown", actions.handleGlobalKeyEvent, true);

    void actions.bootstrap().catch((error) => {
      setState("bootError", error.message);
    });
  });

  onCleanup(() => {
    cleanup.forEach((dispose) => dispose());
    window.removeEventListener("keydown", actions.handleGlobalKeyEvent, true);
    terminal.close({ disposeTerminal: true, intentional: true });
  });

  return (
    <Show
      when={state.authenticated}
      fallback={<LoginView state={state} actions={actions} />}
    >
      <Workspace state={state} actions={actions} terminal={terminal} />
    </Show>
  );
}
