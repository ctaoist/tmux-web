import { For } from "solid-js";
import { LOCKED_COMMAND_ITEMS, UNLOCKED_COMMAND_ITEMS } from "../commands";

export default function CommandBar(props) {
  const items = () => (
    props.state.mode === "locked" ? LOCKED_COMMAND_ITEMS : UNLOCKED_COMMAND_ITEMS
  );

  return (
    <footer
      class="command-bar"
      classList={{
        "command-bar-locked": props.state.mode === "locked",
        "command-bar-unlocked": props.state.mode !== "locked",
      }}
    >
      <div class="command-items">
        <For each={items()}>
          {(item) => (
            <button
              type="button"
              class="command-item"
              classList={{
                active: Boolean(item.menu && props.state.activeMenu === item.menu),
                "mobile-only-command": Boolean(item.mobileOnly),
                "mode-toggle": item.action === "toggle-mode",
                "mode-toggle-locked": item.action === "toggle-mode" && props.state.mode === "locked",
                "mode-toggle-unlocked": item.action === "toggle-mode" && props.state.mode !== "locked",
              }}
              onClick={() => {
                if (item.menu) props.actions.openCommandMenu(item.menu);
                else props.actions.runTopLevelCommand(item.action);
              }}
            >
              {item.key ? <kbd>{item.key}</kbd> : null}
              {item.action === "toggle-mode" ? (
                <span class="command-item-separator" aria-hidden="true">&gt;</span>
              ) : null}
              <span>{item.label}</span>
            </button>
          )}
        </For>
        <button
          type="button"
          class="sticky-toggle"
          classList={{ active: props.state.stickyKeysVisible }}
          title="Show or hide sticky keys"
          aria-label="Show or hide sticky keys"
          aria-pressed={props.state.stickyKeysVisible ? "true" : "false"}
          onClick={() => props.actions.toggleStickyKeys()}
        >
          <span class="sticky-toggle-icon" aria-hidden="true">⌨</span>
        </button>
      </div>
    </footer>
  );
}
