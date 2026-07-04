import CommandBar from "./CommandBar";
import CommandPanel from "./CommandPanel";
import PaneListOverlay from "./PaneListOverlay";
import StickyKeys from "./StickyKeys";
import TabBar from "./TabBar";
import TerminalStage from "./TerminalStage";

export default function Workspace(props) {
  return (
    <main
      class="workspace"
      classList={{
        "sticky-keys-open": props.state.stickyKeysVisible,
        "command-bar-locked": props.state.mode === "locked",
      }}
    >
      <TabBar state={props.state} actions={props.actions} />
      <TerminalStage
        state={props.state}
        actions={props.actions}
        terminal={props.terminal}
      />
      <StickyKeys
        state={props.state}
        actions={props.actions}
        terminal={props.terminal}
      />
      <CommandBar state={props.state} actions={props.actions} />
      <PaneListOverlay state={props.state} actions={props.actions} />
      <CommandPanel state={props.state} actions={props.actions} />
    </main>
  );
}
