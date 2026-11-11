// PORT handling for the backend process.

export class PortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortError";
  }
}

/** Parse the `PORT` environment variable the gateway sets; throws a clear error when invalid. */
export function parsePort(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env["PORT"];
  if (raw === undefined || raw.trim() === "") {
    throw new PortError("PORT is not set: the Kiro Crew gateway must provide the loopback port to bind");
  }
  if (!/^\d{1,5}$/.test(raw.trim())) {
    throw new PortError(`PORT must be a number between 1 and 65535, got ${JSON.stringify(raw)}`);
  }
  const port = Number(raw.trim());
  if (port < 1 || port > 65535) {
    throw new PortError(`PORT must be between 1 and 65535, got ${port}`);
  }
  return port;
}
