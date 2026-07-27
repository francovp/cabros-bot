import type { PromptProvenance, SearchResult } from '../../../../services/grounding/types';

export interface Alert {
	text: string;
	receivedAt: Date;
	metadata?: object;
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
	promptProvenance?: PromptProvenance;
	technical_levels: TechnicalLevels;
	invalidation_level?: string | number;
	target_level?: string | number;
	setup_type?: 'breakout' | 'mean_reversion' | 'trend_continuation' | 'reversal';
	risk_reward_ratio?: string | number;
	sources: Source[];
	// Legacy fields for backward compatibility during migration
	summary?: string;
	citations?: SearchResult[];
	extraText?: string;
	truncated?: boolean;
}

export interface TelegramMessage {
	text: string;
	parseMode?: string;
	disableWebPagePreview?: boolean;
}

export interface AlertHandlerResponse {
	success: boolean;
	messageId?: string;
	enriched: boolean;
	error?: string;
}

export interface MessageFormatterOptions {
	parseMode?: 'MarkdownV2';
	disableWebPagePreview?: boolean;
}

export type AlertFormatter = (alert: EnrichedAlert, options: MessageFormatterOptions) => string;
