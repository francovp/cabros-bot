export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
  sourceDomain: string;
}

export interface Source {
  title: string;
  url: string;
  snippet?: string;
}

export interface TechnicalLevels {
  supports: string[];
  resistances: string[];
}

export interface EnrichedAlert {
  original_text: string;
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  sentiment_score: number;
  insights: string[];
  technical_levels: TechnicalLevels;
  sources: Source[];
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

export enum PromptType {
  ALERT_ENRICHMENT = 'ALERT_ENRICHMENT',
  NEWS_ANALYSIS = 'NEWS_ANALYSIS',
  DEFAULT = 'DEFAULT'
}

export interface GroundAlertRequest {
  text: string;
  maxSources?: number;
  timeoutMs?: number;
  systemPrompt?: string;
  promptType?: PromptType;
}

export interface GroundAlertResponse {
  summary: string;
  citations: SearchResult[];
  confidence?: number;
}