// Stand-in for @kirocrew/app-sdk in tests: a recording api.
export interface RecordedCall {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
}

export const calls: RecordedCall[] = [];

export function useAppApi() {
  return {
    get: async <T>(path: string): Promise<T> => {
      calls.push({ method: "GET", path });
      return {} as T;
    },
    post: async <T>(path: string, body?: unknown): Promise<T> => {
      calls.push({ method: "POST", path, body });
      return {} as T;
    },
  };
}
