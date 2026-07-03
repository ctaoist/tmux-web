import { createEffect, For, Show } from "solid-js";
import { STICKY_KEYS } from "../keyboard";

export default function StickyKeys(props) {
  createEffect(() => {
    props.state.stickyKeysVisible;
    props.terminal.requestFit({ settle: true });
  });

  return (
    <div class="sticky-keys" hidden={!props.state.stickyKeysVisible}>
      <Show when={props.state.stickyKeysVisible}>
        <div class="sticky-key-row">
          <For each={STICKY_KEYS}>
            {(key) => (
              <button
                type="button"
                class="sticky-key"
                classList={{
                  active: key.kind === "modifier" && props.state.stickyModifiers[key.id],
                }}
                aria-pressed={
                  key.kind === "modifier" && props.state.stickyModifiers[key.id]
                    ? "true"
                    : "false"
                }
                onClick={() => props.actions.handleStickyKey(key)}
              >
                {key.label}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
