import { For } from "solid-js";

export default function TabBar(props) {
  return (
    <header class="nav-bars">
      <section class="sessionbar">
        <div class="session-select-wrap">
          <select
            class="session-select"
            value={props.state.activeSession}
            onChange={(event) => void props.actions.setActiveSession(event.currentTarget.value)}
          >
            <For each={props.state.sessions}>
              {(session) => (
                <option value={session.name}>
                  {session.name} ({session.windows}w)
                </option>
              )}
            </For>
          </select>
        </div>
        <div class="tab-actions">
          <button
            type="button"
            class="icon-button"
            title="Refresh sessions"
            aria-label="Refresh sessions"
            onClick={() => void props.actions.refreshSessions()}
          >
            R
          </button>
          <button
            type="button"
            class="icon-button"
            title="New session"
            aria-label="New session"
            onClick={() => void props.actions.createSession()}
          >
            +
          </button>
          <button
            type="button"
            class="icon-button danger-button"
            title="Kill session"
            aria-label="Kill session"
            disabled={!props.state.activeSession}
            onClick={() => void props.actions.killSession(props.state.activeSession)}
          >
            x
          </button>
        </div>
      </section>
      <section class="tabbar">
        <div class="tabs">
          <For each={props.state.windows}>
            {(window) => (
              <div
                class="window-tab"
                classList={{ active: window.id === props.state.activeWindowId }}
                title={`${window.index}: ${window.name}`}
              >
                <button
                  type="button"
                  class="window-tab-main"
                  onClick={() => void props.actions.setActiveWindow(window.id)}
                >
                  <span class="window-name">{window.index}: {window.name}</span>
                  <span class="window-meta">{window.zoomed ? "Z" : `${window.panes}p`}</span>
                </button>
                <button
                  type="button"
                  class="close-tab"
                  title="Kill window"
                  aria-label="Kill window"
                  onClick={() => void props.actions.killWindow(window.id)}
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
            title="Refresh windows"
            aria-label="Refresh windows"
            disabled={!props.state.activeSession}
            onClick={() => void props.actions.refreshWindows(props.state.activeSession)}
          >
            R
          </button>
          <button
            type="button"
            class="icon-button"
            title="New window"
            aria-label="New window"
            disabled={!props.state.activeSession}
            onClick={() => void props.actions.createWindow()}
          >
            +
          </button>
        </div>
      </section>
    </header>
  );
}
