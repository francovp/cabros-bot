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

export interface PromptProvenance {
  name: string;
  source: 'langfuse' | 'local';
  label: string | null;
  version: number | null;
}

export interface PriceData {
  current_price: number | null;
  high?: number | string;
  low?: number | string;
  open?: number | string;
  previous_close?: number | string;
  volume?: number | string;
  [key: string]: unknown;
}

export interface EnrichedAlert {
  original_text: string;
  tradingViewEnrichmentApplied?: boolean;
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  sentiment_score: number;
  current_price: number | null;
  price_data?: PriceData | null;
  insights: string[];
  promptProvenance?: PromptProvenance;
  technical_levels?: TechnicalLevels;
  invalidation_level?: string | number;
  target_level?: string | number;
  setup_type?: 'breakout' | 'mean_reversion' | 'trend_continuation' | 'reversal';
  risk_reward_ratio?: string | number;
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
