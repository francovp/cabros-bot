const { buildExpandedAnalysisAlertReport } = require('./src/services/tradingview/expandedAnalysisAlertReport');

const mockItems = [
    {
        input: { symbol: 'NASDAQ:TSLA' },
        analysis: {
            technical: {
                price_data: { current_price: 248.30, change_percent: 1.2 },
                technical_indicators: { RSI: 58.9, SMA20: 240.0, MACD: 1.5, MACD_signal: 1.0, ATR: 12.4 }
            }
        }
    },
    {
        input: { symbol: 'NASDAQ:AAPL' },
        analysis: {
            technical: {
                price_data: { current_price: 180.10, change_percent: -0.5 },
                technical_indicators: { RSI: 32.1, SMA20: 190.0, MACD: -0.5, MACD_signal: -0.2, ATR: 5.2 }
            }
        }
    },
    {
        input: { symbol: 'NASDAQ:MSFT' },
        analysis: {
            technical: {
                price_data: { current_price: 410.50, change_percent: 0.8 },
                technical_indicators: { RSI: 30.5, SMA20: 420.0, MACD: -1.2, MACD_signal: -1.5, ATR: 8.1 }
            }
        }
    },
    {
        input: { symbol: 'BINANCE:BTCUSDT' },
        analysis: {
            technical: {
                price_data: { current_price: 65000, change_percent: 2.1 },
                technical_indicators: { RSI: 22.4, SMA20: 68000, MACD: -10, MACD_signal: -15, ATR: 1500 }
            }
        }
    },
    {
        input: { symbol: 'BINANCE:ETHUSDT' },
        analysis: {
            technical: {
                price_data: { current_price: 3500, change_percent: -1.1 },
                technical_indicators: { RSI: 20.1, SMA20: 3700, MACD: -5, MACD_signal: -8, ATR: 100 }
            }
        }
    },
    {
        input: { symbol: 'NASDAQ:NVDA' },
        analysis: {
            technical: {
                price_data: { current_price: 130.20, change_percent: 3.5 },
                technical_indicators: { RSI: 75.4, SMA20: 120.0, MACD: 2.1, MACD_signal: 1.8, ATR: 4.5 }
            }
        }
    }
];

console.log(buildExpandedAnalysisAlertReport(mockItems));
