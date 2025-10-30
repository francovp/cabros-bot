import type { SearchResult } from '../../../../services/grounding/types';

export interface Alert {
	text: string;
	receivedAt: Date;
	metadata?: object;
}

export interface EnrichedAlert {
	originalText: string;
	summary: string;
	citations: SearchResult[];
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