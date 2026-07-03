import { createEffect, createMemo, on, onCleanup, onMount, Show } from "solid-js";

export default function TerminalStage(props) {
  return (
    <section class="terminal-stage">
      <Show
        when={props.state.activeSession}
        fallback={
          <div class="empty-state">
            <div>No tmux session selected</div>
            <button type="button" onClick={() => void props.actions.createSession()}>
              Create session
            </button>
          </div>
        }
      >
        <TerminalHost
          terminal={props.terminal}
          activeSession={props.state.activeSession}
          theme={props.state.theme}
        />
      </Show>
      <ConnectionOverlay state={props.state} />
    </section>
  );
}

function TerminalHost(props) {
  let terminalElement;

  onMount(() => {
    props.terminal.mount(terminalElement);
  });

  createEffect(on(
    () => props.activeSession,
    (_session, previousSession) => {
      props.terminal.sync(Boolean(previousSession));
    },
  ));

  createEffect(() => {
    props.terminal.applyTheme(props.theme);
  });

  onCleanup(() => {
    props.terminal.unmount();
  });

  return <div ref={terminalElement} class="terminal" />;
}

function ConnectionOverlay(props) {
  const overlay = createMemo(() => {
    if (props.state.connectionMessage) {
      return {
        message: props.state.connectionMessage,
        transient: props.state.connectionTransient,
        detail: props.state.reconnectPending ? "Press Enter to reconnect" : "",
      };
    }
    if (props.state.connectionStatus === "connecting" || props.state.connectionStatus === "reconnecting") {
      return {
        message: props.state.connectionStatus === "reconnecting" ? "Reconnecting..." : "Connecting...",
        transient: true,
        detail: "",
      };
    }
    return null;
  });

  return (
    <Show when={overlay()}>
      <div class="connection-overlay">
        <div
          class="connection-card"
          classList={{ transient: Boolean(overlay()?.transient) }}
        >
          <strong>{overlay()?.message}</strong>
          <Show when={overlay()?.detail}>
            <span><kbd>Enter</kbd> {overlay()?.detail.replace("Press Enter ", "")}</span>
          </Show>
        </div>
      </div>
    </Show>
  );
}
