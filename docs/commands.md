# Telegram Bot Commands Reference

[← Back to README](../README.md)

## Commands

### /help, /start

Display the list of available Telegram bot commands, argument syntax, and aliases formatted in MarkdownV2.

**Example:**
```
/help
```

### /precio `<symbol>`

Get real-time price for crypto pairs (Binance) or equities/stocks (Twelve Data).

**Examples:**
```
/precio BTCUSDT
/precio NVDA
/precio NASDAQ:AAPL
```

**Responses:**
```
Precio de BTCUSDT es 65000
Precio de NVDA es 125.50 (+2.32%)
```

### /cryptobot id

Telegram bot utility command to get current Telegram chat ID.

**Example:**
```
/cryptobot id
```

### /analisis `<symbols>` (alias: `/analysis`)

Create a TradingView technical analysis background job.

**Example:**
```
/analisis BINANCE:BTCUSDT,NASDAQ:NVDA timeframe=1D mtf=true
```

### /scanner `[options]`

Create a TradingView market scanner background job (`top_gainers`, `top_losers`, `breakouts`).

**Example:**
```
/scanner scans=top_gainers,top_losers exchange=BINANCE timeframe=4h limit=10
```

### /jobs `[jobId]` (alias: `/trabajos`)

List recent TradingView jobs or inspect one job's progress, terminal status, compact result summary, and notification delivery state. Expired terminal jobs are reported as unavailable.

**Examples:**
```
/jobs
/jobs 4f0c2f2e-7e6b-4c4c-8f9a-2e1a3c4b5d6e
```

### /noticias `[options]` (alias: `/news`)

Run the news monitor and AI sentiment analysis.

**Example:**
```
/noticias crypto=BTCUSDT,ETHUSDT stocks=NVDA
```
