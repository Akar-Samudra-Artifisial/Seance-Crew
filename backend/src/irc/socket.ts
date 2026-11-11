// The WebSocket subset the bridge uses, so tests can inject an in-process socket.

export const READY_STATE = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const;

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code?: number; readonly reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

/** Node's global WebSocket (Node >= 22). It sends no Origin header, which the Séance server accepts. */
export const createWebSocket: SocketFactory = (url) => {
  const Ctor = (globalThis as unknown as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
  if (Ctor === undefined) throw new Error("global WebSocket is not available (Node >= 22 is required)");
  return new Ctor(url);
};
