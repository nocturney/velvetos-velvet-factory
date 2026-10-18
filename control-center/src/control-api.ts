import type { ControlSnapshot, SearchResult } from "./types";

const DEFAULT_BASE = "/api/control";

export class ControlApiClient {
  constructor(private readonly baseUrl = DEFAULT_BASE) {}

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(this.baseUrl + path, {
      credentials: "same-origin",
      signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Control API ${response.status}`);
    return response.json() as Promise<T>;
  }

  snapshot(signal?: AbortSignal): Promise<ControlSnapshot> {
    return this.get<ControlSnapshot>("/v1/snapshot", signal);
  }

  async search(query: string): Promise<SearchResult[]> {
    const payload = await this.get<{ items?: SearchResult[] } | SearchResult[]>(
      `/v1/search?q=${encodeURIComponent(query)}`,
    );
    return Array.isArray(payload) ? payload : payload.items ?? [];
  }
}

export const controlApi = new ControlApiClient();
