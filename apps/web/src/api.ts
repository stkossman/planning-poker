export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
      ? body.message : 'The request failed. Please try again.';
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
