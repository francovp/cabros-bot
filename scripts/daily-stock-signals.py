#!/usr/bin/env python3
"""Daily stock signals for watchlist — sends results via stdout."""
import sys
import json
sys.path.insert(0, '/home/ubuntu/.openclaw/workspace/skills/tradingview-screener/.venv/lib/python3.12/site-packages')

from tvscreener import StockScreener, StockField

# Full watchlist
tickers = [
    'NASDAQ:SNDK','NASDAQ:META','NASDAQ:WDC','NASDAQ:SMCI','NASDAQ:AMD','NASDAQ:MU',
    'NASDAQ:INTC','NYSE:TSM','NASDAQ:ASML','NASDAQ:NVDA','NASDAQ:TSLA','NYSE:BABA',
    'NASDAQ:GOOG','NASDAQ:AVGO','NYSE:ORCL','NASDAQ:AMZN','NASDAQ:MSFT','NASDAQ:AAPL','NASDAQ:QCOM',
    'NYSE:BCH','NYSE:CCU','NYSE:SQM','NYSE:BSAC','NYSE:ENIC',
    'NYSE:GS','NYSE:AMX','NYSE:JPM','NYSE:KO','NYSE:BRK.A','NASDAQ:NFLX',
    'NASDAQ:CRML','NASDAQ:USAR','NYSE:EQT','NYSE:NEE',
    'NYSE:AXP',
    'AMEX:SLV','AMEX:COPX','AMEX:GLD','NASDAQ:NDX','AMEX:VEA','TVC:SILVER','CAPITALCOM:COPPER','CAPITALCOM:GOLD',
    'NASDAQ:MSTR','BINANCE:BTCUSDT','BINANCE:BNBUSDT','BINANCE:ETHUSDT',
    'FX_IDC:USDCLP'
]

symbols = {"query": {"types": []}, "tickers": tickers}

sc = StockScreener()
sc.symbols = symbols
sc.select(
    StockField.NAME, StockField.PRICE, StockField.CHANGE_PERCENT, StockField.RSI9,
    StockField.VOLUME, StockField.MARKET_CAPITALIZATION,
    StockField.SIMPLE_MOVING_AVERAGE_50, StockField.SIMPLE_MOVING_AVERAGE_200,
    StockField.PRICE_TO_EARNINGS_RATIO_TTM
)
sc.sort_by(StockField.RSI9, ascending=True)
df = sc.get()

# Build signal output
lines = []
lines.append("📊 SEÑALES DE HOY")
lines.append("")

# Oversold extreme: RSI < 20
oversold = df[df['Rsi9'] < 20]
if not oversold.empty:
    lines.append("🚨 *SOBRESVENDIDOS EXTREMOS — COMPRA!*")
    for _, row in oversold.iterrows():
        name = row['Name']
        price = row['Price']
        chg = row['Change %']
        rsi = row['Rsi9']
        pe = row['Price to Earnings Ratio (TTM)']
        lines.append(f"  {name}: ${price:.2f} ({chg:+.2f}%) | RSI {rsi:.1f} | P/E {pe:.1f}")
    lines.append("")

# Oversold: RSI 20-35
over = df[(df['Rsi9'] >= 20) & (df['Rsi9'] < 35)]
if not over.empty:
    lines.append("⚠️ *SOBRESVENDIDOS — CONSIDERAR COMPRA*")
    for _, row in over.iterrows():
        name = row['Name']
        price = row['Price']
        chg = row['Change %']
        rsi = row['Rsi9']
        pe = row['Price to Earnings Ratio (TTM)']
        sma50 = row.get('Simple Moving Average (50)', None)
        note = ""
        if sma50 and price < sma50:
            note = f" | Precio bajo SMA50"
        lines.append(f"  {name}: ${price:.2f} ({chg:+.2f}%) | RSI {rsi:.1f}{note}")
    lines.append("")

# Overbought: RSI > 65
overbought = df[df['Rsi9'] > 65]
if not overbought.empty:
    lines.append("🔴 *SOBRECOMPRADOS — TOMA DE GANANCIAS*")
    for _, row in overbought.iterrows():
        name = row['Name']
        price = row['Price']
        chg = row['Change %']
        rsi = row['Rsi9']
        lines.append(f"  {name}: ${price:.2f} ({chg:+.2f}%) | RSI {rsi:.1f}")
    lines.append("")

# Neutral
neutral = df[(df['Rsi9'] >= 35) & (df['Rsi9'] <= 65)]
if not neutral.empty:
    lines.append("🟡 *NEUTROS — MANTENER*")
    for _, row in neutral.iterrows():
        name = row['Name']
        price = row['Price']
        chg = row['Change %']
        rsi = row['Rsi9']
        lines.append(f"  {name}: ${price:.2f} ({chg:+.2f}%) | RSI {rsi:.1f}")
    lines.append("")

lines.append("---")
lines.append("Mercado americano · TradingView delayed data")

print("\n".join(lines))
