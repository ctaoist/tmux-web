import { render } from "solid-js/web";
import "@xterm/xterm/css/xterm.css";
import "../styles/styles.css";
import App from "./App";

const app = document.querySelector("#app");

render(() => <App />, app);
