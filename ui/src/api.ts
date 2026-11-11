// Every path the page requests. useAppApi() adds no prefix: the path is checked against `permissions.api` in app.json
// and then fetched as given, so the page must use the full reverse-proxy path /apps/<name>/api/<route>. A test checks
// APP_NAME against app.json and that every route here is listed in permissions.api.

export const APP_NAME = "seance-crew";
export const API_BASE = `/apps/${APP_NAME}/api`;

export const ROUTES = {
  state: `${API_BASE}/state`,
  summary: `${API_BASE}/summary`,
  summon: `${API_BASE}/summon`,
  grantOp: `${API_BASE}/grant-op`,
  exorcise: `${API_BASE}/exorcise`,
  inboxDismiss: `${API_BASE}/inbox/dismiss`,
} as const;

export const stateUrl = (since: number | null): string => (since === null ? ROUTES.state : `${ROUTES.state}?since=${since}`);
