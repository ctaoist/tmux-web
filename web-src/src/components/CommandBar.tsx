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
      <div
        class="mode-pill"
        classList={{
          locked: props.state.mode === "locked",
          unlocked: props.state.mode !== "locked",
        }}
      >
        {props.state.mode === "locked" ? "LOCKED" : "COMMAND"}
      </div>
      <div class="command-items">
        <For each={items()}>
          {(item) => (
            <button
              type="button"
              class="command-item"
              classList={{ active: Boolean(item.menu && props.state.activeMenu === item.menu) }}
              onClick={() => {
                if (item.menu) props.actions.openCommandMenu(item.menu);
                else props.actions.runTopLevelCommand(item.action);
              }}
            >
              <kbd>{item.key}</kbd>
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
