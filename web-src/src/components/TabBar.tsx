import { For } from "solid-js";

export default function TabBar(props) {
  return (
    <header class="tabbar">
      <div class="tabs">
        <For each={props.state.sessions}>
          {(session) => (
            <div
              class="session-tab"
              classList={{ active: session.name === props.state.activeSession }}
              title={session.name}
            >
              <button
                type="button"
                class="session-tab-main"
                onClick={() => props.actions.setActiveSession(session.name)}
              >
                <span class="session-name">{session.name}</span>
                <span class="session-meta">{session.windows}w</span>
              </button>
              <button
                type="button"
                class="close-tab"
                title="Kill session"
                onClick={() => void props.actions.killSession(session.name)}
              >
                x
              </button>
            </div>
          )}
        </For>
      </div>
      <div class="tab-actions">
        <button
          type="button"
          class="icon-button"
          title="Refresh sessions"
          onClick={() => void props.actions.refreshSessions()}
        >
          R
        </button>
        <button
          type="button"
          class="primary-button"
          onClick={() => void props.actions.createSession()}
        >
          New
        </button>
      </div>
    </header>
  );
}
