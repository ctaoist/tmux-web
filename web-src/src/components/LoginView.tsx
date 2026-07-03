import { createMemo, createSignal, onMount } from "solid-js";

export default function LoginView(props) {
  const [error, setError] = createSignal("");
  let tokenInput;

  const message = createMemo(() => error() || props.state.bootError || "");

  onMount(() => {
    tokenInput?.focus();
  });

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    try {
      await props.actions.login(tokenInput.value);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <main class="login-surface">
      <section class="login-panel">
        <div class="login-mark">tmux web</div>
        <form class="login-form" onSubmit={handleSubmit}>
          <input
            ref={tokenInput}
            type="password"
            autocomplete="current-password"
            placeholder="Token"
          />
          <button type="submit">Connect</button>
        </form>
        <p class="login-error" role="alert">{message()}</p>
      </section>
    </main>
  );
}
