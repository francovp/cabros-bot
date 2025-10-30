export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
  sourceDomain: string;
}

export interface GroundedContext {
  query: string;
  results: SearchResult[];
  timestamp: Date;
}

export interface GeminiResponse {
  summary: string;
  confidence?: number;
  citations: SearchResult[];
  error?: string;
}

export interface DeriveQueryRequest {
  alertText: string;
  maxLength?: number;
}

export interface DeriveQueryResponse {
  query: string;
  confidence: number;
}

export interface SearchRequest {
  query: string;
  maxResults?: number;
}

export interface SearchResponse {
  results: SearchResult[];
  totalResults: number;
}

export interface GroundAlertRequest {
  text: string;
  maxSources?: number;
  timeoutMs?: number;
  systemPrompt?: string;
}

export interface GroundAlertResponse {
  summary: string;
  citations: SearchResult[];
  confidence?: number;
}