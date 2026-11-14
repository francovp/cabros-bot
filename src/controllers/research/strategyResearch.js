'use strict';

/* global AbortController */

const { v4: uuidv4 } = require('uuid');
const { getRuntimeConfig } = require('../../services/remoteConfig/RemoteConfigService');
const { tradingViewMcpService } = require('../../services/tradingview/TradingViewMcpService');
const {
	StrategyResearchRequestError,
	parseCompareStrategiesRequest,
	parseWalkForwardRequest,
	parseBacktestRequest,
} = require('../../services/tradingview/strategyResearchRequest');
const { strategyResearchCache } = require('../../services/tradingview/strategyResearchCache');
const { strategyResearchStorageService } = require('../../services/storage/StrategyResearchStorageService');
const sentryService = require('../../services/monitoring/SentryService');

const DEFAULT_RESEARCH_TIMEOUT_MS = 30000;

function isFeatureEnabled() {
	try {
		return Boolean(getRuntimeConfig().ENABLE_STRATEGY_RESEARCH);
	} catch (error) {
		return process.env.ENABLE_STRATEGY_RESEARCH === 'true';
	}
}

function getCacheTtlMs() {
	try {
		const ttl = getRuntimeConfig().STRATEGY_RESEARCH_CACHE_TTL_MS;
		if (Number.isFinite(ttl) && ttl > 0) return ttl;
	} catch (e) {
		if (process.env.STRATEGY_RESEARCH_CACHE_TTL_MS) {
			const parsed = parseInt(process.env.STRATEGY_RESEARCH_CACHE_TTL_MS, 10);
			if (Number.isFinite(parsed) && parsed > 0) return parsed;
		}
	}
	return 300000;
}

function handleResearchError(error, res, { requestId, startTime, toolName }) {
	const processingTimeMs = Math.max(0, Date.now() - startTime);

	if (error instanceof StrategyResearchRequestError) {
		return res.status(400).json({
			success: false,
			error: error.message,
			code: error.code || 'INVALID_REQUEST',
			requestId,
			processingTimeMs,
		});
	}

	const errorMessage = error && typeof error.message === 'string' ? error.message : '';

	if (error?.name === 'AbortError' || errorMessage.includes('timeout') || errorMessage.includes('aborted')) {
		console.warn(`[StrategyResearch] ${toolName} timed out:`, errorMessage || 'timeout');
		return res.status(504).json({
			success: false,
			error: `Strategy research call timed out: ${errorMessage || 'operation timed out'}`,
			code: 'STRATEGY_RESEARCH_TIMEOUT',
			requestId,
			processingTimeMs,
		});
	}

	if (errorMessage && (errorMessage.includes('429') || errorMessage.toLowerCase().includes('rate limit'))) {
		console.warn(`[StrategyResearch] ${toolName} upstream rate limit:`, error.message);
		return res.status(429).json({
			success: false,
			error: error.message,
			code: 'UPSTREAM_RATE_LIMITED',
			requestId,
			processingTimeMs,
		});
	}

	console.error(`[StrategyResearch] ${toolName} failed:`, error.message);
	sentryService.captureRuntimeError({
		error,
		location: `strategyResearch.${toolName}`,
		extra: { requestId, toolName, processingTimeMs },
	});

	return res.status(502).json({
		success: false,
		error: error.message,
		code: 'STRATEGY_RESEARCH_FAILED',
		requestId,
		processingTimeMs,
	});
}

function getCompareStrategies() {
	return async (req, res) => {
		const requestId = uuidv4();
		const startTime = Date.now();
		const toolName = 'compare_strategies';

		if (!isFeatureEnabled()) {
			return res.status(404).json({
				success: false,
				error: 'Strategy research is not enabled',
				code: 'FEATURE_DISABLED',
				requestId,
				processingTimeMs: 0,
			});
		}

		let parsed;
		try {
			parsed = parseCompareStrategiesRequest(req);
		} catch (error) {
			return handleResearchError(error, res, { requestId, startTime, toolName });
		}

		const cacheParams = {
			symbol: parsed.symbol,
			exchange: parsed.exchange,
			interval: parsed.interval,
			period: parsed.period,
			initial_capital: parsed.initial_capital,
			commission_pct: parsed.commission_pct,
			slippage_pct: parsed.slippage_pct,
		};

		const cacheKey = strategyResearchCache.buildKey(toolName, cacheParams);
		const cachedResult = strategyResearchCache.get(cacheKey);

		if (cachedResult) {
			const processingTimeMs = Math.max(0, Date.now() - startTime);
			return res.status(200).json({
				success: true,
				tool: toolName,
				symbol: parsed.symbol,
				exchange: parsed.exchange,
				interval: parsed.interval,
				period: parsed.period,
				cached: true,
				result: cachedResult,
				requestId,
				processingTimeMs,
			});
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), DEFAULT_RESEARCH_TIMEOUT_MS);

		try {
			const upstreamArgs = {
				symbol: parsed.symbol,
				exchange: parsed.exchange,
				interval: parsed.interval,
				period: parsed.period,
				...(parsed.initial_capital !== undefined ? { initial_capital: parsed.initial_capital } : {}),
				...(parsed.commission_pct !== undefined ? { commission_pct: parsed.commission_pct } : {}),
				...(parsed.slippage_pct !== undefined ? { slippage_pct: parsed.slippage_pct } : {}),
			};

			const result = await tradingViewMcpService.callStrategyResearch(toolName, upstreamArgs, {
				signal: controller.signal,
			});

			clearTimeout(timeoutId);
			strategyResearchCache.set(cacheKey, result, getCacheTtlMs());

			strategyResearchStorageService.saveResearchRun({
				id: requestId,
				tool: toolName,
				symbol: parsed.symbol,
				exchange: parsed.exchange,
				interval: parsed.interval,
				period: parsed.period,
				params: cacheParams,
				result,
				cached: false,
			}).catch((err) => {
				console.warn('[StrategyResearch] Failed background save:', err.message);
			});

			const processingTimeMs = Math.max(0, Date.now() - startTime);
			return res.status(200).json({
				success: true,
				tool: toolName,
				symbol: parsed.symbol,
				exchange: parsed.exchange,
				interval: parsed.interval,
				period: parsed.period,
				cached: false,
				result,
				requestId,
				processingTimeMs,
			});
		} catch (error) {
			clearTimeout(timeoutId);
			return handleResearchError(error, res, { requestId, startTime, toolName });
		}
	};
}

function postWalkForward() {
	return async (req, res) => {
		const requestId = uuidv4();
		const startTime = Date.now();
		const toolName = 'walk_forward_backtest_strategy';

		if (!isFeatureEnabled()) {
			return res.status(404).json({
				success: false,
				error: 'Strategy research is not enabled',
				code: 'FEATURE_DISABLED',
				requestId,
				processingTimeMs: 0,
			});
		}

		let parsed;
		try {
			parsed = parseWalkForwardRequest(req);
		} catch (error) {
			return handleResearchError(error, res, { requestId, startTime, toolName });
		}

		const cacheParams = {
			symbol: parsed.symbol,
			exchange: parsed.exchange,
			strategy: parsed.strategy,
			interval: parsed.interval,
			period: parsed.period,
			n_splits: parsed.n_splits,
			train_ratio: parsed.train_ratio,
			initial_capital: parsed.initial_capital,
			commission_pct: parsed.commission_pct,
			slippage_pct: parsed.slippage_pct,
			include_trade_log: parsed.include_trade_log,
		};

		const cacheKey = strategyResearchCache.buildKey(toolName, cacheParams);
		const cachedResult = strategyResearchCache.get(cacheKey);

		if (cachedResult) {
			const processingTimeMs = Math.max(0, Date.now() - startTime);
			return res.status(200).json({
				success: true,
				tool: toolName,
				symbol: parsed.symbol,
				exchange: parsed.exchange,
				strategy: parsed.strategy,
				interval: parsed.interval,
				period: parsed.period,
				cached: true,
				result: cachedResult,
				requestId,
				processingTimeMs,
			});
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), DEFAULT_RESEARCH_TIMEOUT_MS);

		try {
			const upstreamArgs = {
				symbol: parsed.symbol,
				exchange: parsed.exchange,
				strategy: parsed.strategy,
				interval: parsed.interval,
				period: parsed.period,
				n_splits: parsed.n_splits,
				train_ratio: parsed.train_ratio,
				include_trade_log: parsed.include_trade_log,
				...(parsed.initial_capital !== undefined ? { initial_capital: parsed.initial_capital } : {}),
				...(parsed.commission_pct !== undefined ? { commission_pct: parsed.commission_pct } : {}),
				...(parsed.slippage_pct !== undefined ? { slippage_pct: parsed.slippage_pct } : {}),
			};

			const result = await tradingViewMcpService.callStrategyResearch(toolName, upstreamArgs, {
				signal: controller.signal,
			});

			clearTimeout(timeoutId);
			strategyResearchCache.set(cacheKey, result, getCacheTtlMs());

			strategyResearchStorageService.saveResearchRun({
				id: requestId,
				tool: toolName,
				symbol: parsed.symbol,
				exchange: parsed.exchange,
				strategy: parsed.strategy,
				interval: parsed.interval,
				period: parsed.period,
				params: cacheParams,
				result,
				cached: false,
			}).catch((err) => {
				console.warn('[StrategyResearch] Failed background save:', err.message);
			});

			const processingTimeMs = Math.max(0, Date.now() - startTime);
			return res.status(200).json({
				success: true,
				tool: toolName,
				symbol: parsed.symbol,
				exchange: parsed.exchange,
				strategy: parsed.strategy,
				interval: parsed.interval,
				period: parsed.period,
				cached: false,
				result,
				requestId,
				processingTimeMs,
			});
		} catch (error) {
			clearTimeout(timeoutId);
			return handleResearchError(error, res, { requestId, startTime, toolName });
		}
	};
}

function postBacktest() {
	return async (req, res) => {
		const requestId = uuidv4();
		const startTime = Date.now();
		const toolName = 'backtest_strategy';

		if (!isFeatureEnabled()) {
			return res.status(404).json({
				success: false,
				error: 'Strategy research is not enabled',
				code: 'FEATURE_DISABLED',
				requestId,
				processingTimeMs: 0,
			});
		}

		let parsed;
		try {
			parsed = parseBacktestRequest(req);
		} catch (error) {
			return handleResearchError(error, res, { requestId, startTime, toolName });
		}

		const cacheParams = {
			symbol: parsed.symbol,
			exchange: parsed.exchange,
			strategy: parsed.strategy,
			interval: parsed.interval,
			period: parsed.period,
			initial_capital: parsed.initial_capital,
			commission_pct: parsed.commission_pct,
			slippage_pct: parsed.slippage_pct,
			include_trade_log: parsed.include_trade_log,
		};

		const cacheKey = strategyResearchCache.buildKey(toolName, cacheParams);
		const cachedResult = strategyResearchCache.get(cacheKey);

		if (cachedResult) {
			const processingTimeMs = Math.max(0, Date.now() - startTime);
			return res.status(200).json({
				success: true,
				tool: toolName,
				symbol: parsed.symbol,
				exchange: parsed.exchange,
				strategy: parsed.strategy,
				interval: parsed.interval,
				period: parsed.period,
				cached: true,
				result: cachedResult,
				requestId,
				processingTimeMs,
			});
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), DEFAULT_RESEARCH_TIMEOUT_MS);

		try {
			const upstreamArgs = {
				symbol: parsed.symbol,
				exchange: parsed.exchange,
				strategy: parsed.strategy,
				interval: parsed.interval,
				period: parsed.period,
				include_trade_log: parsed.include_trade_log,
				...(parsed.initial_capital !== undefined ? { initial_capital: parsed.initial_capital } : {}),
				...(parsed.commission_pct !== undefined ? { commission_pct: parsed.commission_pct } : {}),
				...(parsed.slippage_pct !== undefined ? { slippage_pct: parsed.slippage_pct } : {}),
			};

			const result = await tradingViewMcpService.callStrategyResearch(toolName, upstreamArgs, {
				signal: controller.signal,
			});

			clearTimeout(timeoutId);
			strategyResearchCache.set(cacheKey, result, getCacheTtlMs());

			strategyResearchStorageService.saveResearchRun({
				id: requestId,
				tool: toolName,
				symbol: parsed.symbol,
				exchange: parsed.exchange,
				strategy: parsed.strategy,
				interval: parsed.interval,
				period: parsed.period,
				params: cacheParams,
				result,
				cached: false,
			}).catch((err) => {
				console.warn('[StrategyResearch] Failed background save:', err.message);
			});

			const processingTimeMs = Math.max(0, Date.now() - startTime);
			return res.status(200).json({
				success: true,
				tool: toolName,
				symbol: parsed.symbol,
				exchange: parsed.exchange,
				strategy: parsed.strategy,
				interval: parsed.interval,
				period: parsed.period,
				cached: false,
				result,
				requestId,
				processingTimeMs,
			});
		} catch (error) {
			clearTimeout(timeoutId);
			return handleResearchError(error, res, { requestId, startTime, toolName });
		}
	};
}

module.exports = {
	getCompareStrategies,
	postWalkForward,
	postBacktest,
	isFeatureEnabled,
	getCacheTtlMs,
	DEFAULT_RESEARCH_TIMEOUT_MS,
};
