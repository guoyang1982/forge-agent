export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

export interface SearchProvider {
  readonly id: string;
  search(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SearchHit[]>;
}
