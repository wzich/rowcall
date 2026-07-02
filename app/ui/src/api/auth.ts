const tokenQueryParam = "token";
const tokenStorageKey = "nodebook.authToken";
const tokenHeaderName = "X-Nodebook-Token";

export function nodebookAuthHeaders(): Record<string, string> {
  const token = readNodebookAuthToken();
  return token ? { [tokenHeaderName]: token } : {};
}

export async function nodebookFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  return await fetch(input, {
    ...init,
    headers: {
      ...headersToRecord(init.headers),
      ...nodebookAuthHeaders(),
    },
  });
}

function readNodebookAuthToken(): string | null {
  const browser = globalThis as typeof globalThis & {
    location?: Location;
    localStorage?: Storage;
    history?: History;
  };
  const location = browser.location;
  let storage: Storage | undefined;
  try {
    storage = browser.localStorage;
  } catch {
    storage = undefined;
  }
  if (!location || !storage) return null;

  const url = new URL(location.href);
  const token = url.searchParams.get(tokenQueryParam);
  if (token) {
    storage.setItem(tokenStorageKey, token);
    url.searchParams.delete(tokenQueryParam);
    browser.history?.replaceState(null, "", url.toString());
    return token;
  }

  return storage.getItem(tokenStorageKey);
}

function headersToRecord(
  headers: HeadersInit | undefined,
): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}
