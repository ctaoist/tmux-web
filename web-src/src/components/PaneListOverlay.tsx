import { createMemo, For, Show } from "solid-js";

export default function PaneListOverlay(props) {
  const panes = createMemo(() => (
    [...(props.state.paneListPanes || [])].sort((left, right) => {
      if (left.active !== right.active) return left.active ? -1 : 1;
      return left.id.localeCompare(right.id, undefined, { numeric: true });
    })
  ));

  return (
    <Show when={props.state.paneListVisible}>
      <aside class="pane-list-panel">
        <div class="pane-list-head">
          <div class="pane-list-title">Panes</div>
          <div class="pane-list-actions">
            <button
              type="button"
              class="pane-list-refresh"
              title="Refresh panes"
              aria-label="Refresh panes"
              disabled={props.state.paneListLoading}
              onClick={() => void props.actions.refreshPaneList()}
            >
              R
            </button>
            <button
              type="button"
              class="pane-list-close"
              title="Close panes"
              aria-label="Close panes"
              onClick={() => props.actions.closePaneList()}
            >
              x
            </button>
          </div>
        </div>
        <div class="pane-list-grid">
          <For each={panes()}>
            {(pane) => (
              <button
                type="button"
                class="pane-list-item"
                classList={{ active: pane.active }}
                onClick={() => void props.actions.selectPane(pane.id)}
              >
                <span class="pane-list-id">{pane.id}</span>
                <span class="pane-list-size">{pane.width}x{pane.height}</span>
                <span class="pane-list-position">{pane.left},{pane.top}</span>
              </button>
            )}
          </For>
          <Show when={!props.state.paneListLoading && panes().length === 0}>
            <div class="pane-list-empty">No panes</div>
          </Show>
        </div>
      </aside>
    </Show>
  );
}
