import { createMemo, For, Show } from "solid-js";
import { COMMAND_MENUS } from "../commands";

export default function CommandPanel(props) {
  const menu = createMemo(() => {
    if (props.state.mode === "locked" || !props.state.activeMenu) return null;
    return COMMAND_MENUS[props.state.activeMenu] || null;
  });
  const showingSessionList = () => (
    props.state.activeMenu === "session" && props.state.sessionListVisible
  );
  const panelTitle = () => (showingSessionList() ? "Sessions" : menu()?.label);
  const panelSubtitle = () => {
    if (!showingSessionList()) return menu()?.subtitle;
    const count = props.state.sessions.length;
    return `${count} tmux session${count === 1 ? "" : "s"} available. Select one to switch.`;
  };

  return (
    <Show when={menu()}>
      <aside class="command-panel">
        <div class="command-panel-head">
          <div>
            <div class="command-panel-title">{panelTitle()}</div>
            <div class="command-panel-subtitle">{panelSubtitle()}</div>
          </div>
          <button
            type="button"
            class="command-panel-close"
            title={showingSessionList() ? "Back to session commands" : "Close submenu"}
            onClick={() => (
              showingSessionList()
                ? props.actions.closeSessionList()
                : props.actions.closeCommandMenu()
            )}
          >
            {showingSessionList() ? "Back" : "Esc"}
          </button>
        </div>
        <Show
          when={showingSessionList()}
          fallback={
            <div class="submenu-grid">
              <For each={menu()?.actions || []}>
                {(action) => (
                  <button
                    type="button"
                    class="submenu-action"
                    classList={{ danger: Boolean(action.danger) }}
                    onClick={() => void props.actions.executeMenuAction(action.id)}
                  >
                    <kbd>{action.key}</kbd>
                    <span>
                      <strong>{action.label}</strong>
                      <small>{action.detail}</small>
                    </span>
                  </button>
                )}
              </For>
            </div>
          }
        >
          <Show
            when={props.state.sessions.length > 0}
            fallback={<div class="session-menu-empty">No tmux sessions</div>}
          >
            <div class="session-menu-grid">
              <For each={props.state.sessions}>
                {(session) => (
                  <button
                    type="button"
                    class="session-menu-item"
                    classList={{ active: session.name === props.state.activeSession }}
                    aria-current={session.name === props.state.activeSession ? "true" : undefined}
                    onClick={() => void props.actions.selectSessionFromList(session.name)}
                  >
                    <span class="session-menu-copy">
                      <strong>{session.name}</strong>
                      <small>
                        {session.windows} window{session.windows === 1 ? "" : "s"}
                        {" · "}{session.attached} attached
                      </small>
                    </span>
                    <span class="session-menu-state">
                      {session.name === props.state.activeSession ? "Active" : session.id}
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </aside>
    </Show>
  );
}
