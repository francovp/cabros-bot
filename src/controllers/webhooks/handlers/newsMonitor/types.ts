/**
 * TypeScript type definitions for News Monitor feature
 * 003-news-monitor
 */

// Event categories for market event classification
export enum EventCategory {
  PRICE_SURGE = 'price_surge',
  PRICE_DECLINE = 'price_decline',
  PUBLIC_FIGURE = 'public_figure',
  REGULATORY = 'regulatory',
  NONE = 'none'
}

// Analysis result status enum
export enum AnalysisStatus {
  ANALYZED = 'analyzed',
  CACHED = 'cached',
  TIMEOUT = 'timeout',
  ERROR = 'error'
}

/**
 * Market context from Binance or Gemini
 */
export interface MarketContext {
  price: number;
  change24h: number;
  volume24h?: number;
  source: 'binance' | 'gemini';
  timestamp: number;
}

/**
 * Enrichment metadata from optional LLM
 */
export interface EnrichmentMetadata {
  original_confidence: number;
  enriched_confidence: number;
  enrichment_applied: boolean;
  reasoning_excerpt: string;
  model_name: string;
  processing_time_ms: number;
}

/**
 * Notification delivery result (from existing 002-whatsapp-alerts)
 */
export interface NotificationDeliveryResult {
  success: boolean;
  channel: 'telegram' | 'whatsapp';
  messageId?: string;
  error?: string;
  attemptCount: number;
  durationMs: number;
}

/**
 * News alert with confidence scoring
 */
export interface NewsAlert {
  symbol: string;
  eventCategory: EventCategory;
  headline: string;
  sentimentScore: number;
  confidence: number;
  sources: string[];
  formattedMessage: string;
  timestamp: number;
  marketContext?: MarketContext;
  enrichmentMetadata?: EnrichmentMetadata;
}

/**
 * Error detail for analysis failures
 */
export interface ErrorDetail {
  code: string;
  message: string;
  originalError?: string;
}

/**
 * Per-symbol analysis result
 */
export interface AnalysisResult {
  symbol: string;
  status: AnalysisStatus;
  alert?: NewsAlert;
  deliveryResults?: NotificationDeliveryResult[];
  error?: ErrorDetail;
  totalDurationMs: number;
  cached: boolean;
  requestId: string;
}

/**
 * Analysis summary statistics
 */
export interface AnalysisSummary {
  total: number;
  analyzed: number;
  cached: number;
  timeout: number;
  error: number;
  alerts_sent: number;
}

/**
 * HTTP response for news monitor endpoint
 */
export interface NewsMonitorResponse {
  success: boolean;
  partial_success?: boolean;
  results: AnalysisResult[];
  summary: AnalysisSummary;
  totalDurationMs: number;
  requestId: string;
}

/**
 * HTTP request for news monitor endpoint
 */
export interface NewsMonitorRequest {
  crypto?: string[];
  stocks?: string[];
}

/**
 * Cached analysis data for deduplication
 */
export interface CachedAnalysisData {
  alert: NewsAlert | null;
  analysisResult: AnalysisResult;
  deliveryResults?: NotificationDeliveryResult[];
}

/**
 * Cache entry for deduplication
 */
export interface CacheEntry {
  key: string;
  timestamp: number;
  data: CachedAnalysisData;
}

/**
 * Gemini analysis response
 */
export interface GeminiAnalysisResponse {
  event_category: EventCategory;
  event_significance: number;
  sentiment_score: number;
  headline: string;
  sources: string[];
}

/**
 * Market context for analysis
 */
export interface MarketContextData {
  price?: number;
  change24h?: number;
  volume24h?: number;
  source: 'binance' | 'gemini';
}

/**
 * Azure LLM enrichment response
 */
export interface LLMEnrichmentResponse {
  confidence: number;
  reasoning: string;
  model: string;
}
