export type ConfigResponse = {
  theme?: string;
};

export type MeResponse = {
  authenticated: boolean;
};

export async function api(
  path: string,
  options: RequestInit = {},
  onUnauthorized?: () => void,
): Promise<any> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  if (response.status === 401) {
    onUnauthorized?.();
    throw new Error("unauthorized");
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || response.statusText);
  }

  return response.json();
}

export async function fetchMe(): Promise<MeResponse> {
  const response = await fetch("/api/me", { credentials: "same-origin" });
  return response.json();
}

export async function fetchConfig(): Promise<ConfigResponse> {
  return fetch("/api/config", { credentials: "same-origin" })
    .then((response) => (response.ok ? response.json() : {}))
    .catch(() => ({}));
}
