// Minimal hand-written types for the parts of @kirocrew/app-sdk this page uses. The SDK is provided by the host at
// runtime and is not on npm, so this file is for typecheck only (the bundle keeps both modules external).
// It can be replaced by the gateway's own declaration, see .kiro/specs/dashboard-ui/design.md.
declare module "@kirocrew/app-sdk" {
  /** Thrown for a non-2xx answer: `message` is `API <status>: <body text>`. */
  export class AppApiError extends Error {
    readonly status: number;
  }
  export interface AppApi {
    /**
     * GET a full proxy path (/apps/<name>/api/...; the SDK adds no prefix). The path must be listed in
     * `permissions.api` (the pathname is matched, a query string passes); otherwise this throws synchronously, before
     * any request. Rejects with AppApiError on a non-2xx answer.
     */
    get<T = unknown>(path: string): Promise<T>;
    /** POST a JSON body to a full proxy path; same permission check and AppApiError as `get`. */
    post<T = unknown>(path: string, body?: unknown): Promise<T>;
  }
  export function useAppApi(): AppApi;
}

declare module "@kirocrew/app-sdk/ui" {
  import type { ReactNode } from "react";
  export function PageHeader(props: { title: string; subtitle?: string; children?: ReactNode }): ReactNode;
  export function Card(props: { children?: ReactNode; className?: string }): ReactNode;
  export function CardTitle(props: { children?: ReactNode; className?: string }): ReactNode;
  export function StatCard(props: { label: string; value: ReactNode; accent?: boolean }): ReactNode;
}
