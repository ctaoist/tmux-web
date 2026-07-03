import { createMemo, For, Show } from "solid-js";
import { COMMAND_MENUS } from "../commands";

export default function CommandPanel(props) {
  const menu = createMemo(() => {
    if (props.state.mode === "locked" || !props.state.activeMenu) return null;
    return COMMAND_MENUS[props.state.activeMenu] || null;
  });

  return (
    <Show when={menu()}>
      <aside class="command-panel">
        <div class="command-panel-head">
          <div>
            <div class="command-panel-title">{menu()?.label}</div>
            <div class="command-panel-subtitle">{menu()?.subtitle}</div>
          </div>
          <button
            type="button"
            class="command-panel-close"
            title="Close submenu"
            onClick={() => props.actions.closeCommandMenu()}
          >
            Esc
          </button>
        </div>
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
      </aside>
    </Show>
  );
}
