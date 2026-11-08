#!/usr/bin/env python3
import sys
import json
import subprocess
from datetime import datetime

sys.path.insert(0, '/home/ubuntu/.openclaw/workspace/skills/tradingview-screener/.venv/lib/python3.12/site-packages')
from tvscreener import StockScreener, StockField

# Full watchlist from watchlist-stocks.md
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
    StockField.SYMBOL, StockField.NAME, StockField.PRICE, StockField.CHANGE_PERCENT, StockField.RSI9,
    StockField.VOLUME, StockField.MARKET_CAPITALIZATION,
    StockField.SIMPLE_MOVING_AVERAGE_50, StockField.SIMPLE_MOVING_AVERAGE_200,
    StockField.PRICE_TO_EARNINGS_RATIO_TTM, StockField.FREE_CASH_FLOW
)
sc.sort_by(StockField.RSI9, ascending=True)
df = sc.get()

# Prepare categories
extreme = []  # RSI < 25
oversold = [] # RSI 25-35
neutral = []  # RSI 35-65
overbought = [] # RSI > 70

for _, row in df.iterrows():
    data = {
        'ticker': row['Symbol'],
        'name': row['Name'],
        'price': row['Price'],
        'change': row['Change %'],
        'rsi': row['Rsi9'],
        'pe': row['Price to Earnings Ratio (TTM)'],
        'sma50': row.get('Simple Moving Average (50)', None),
        'fcf': row.get('Free Cash Flow', None)
    }
    rsi = data['rsi']
    if rsi < 25:
        extreme.append(data)
    elif 25 <= rsi < 35:
        oversold.append(data)
    elif 35 <= rsi <= 65:
        neutral.append(data)
    elif rsi > 70:
        overbought.append(data)

# Now we have the data. We'll print in the required format.
from datetime import datetime
now = datetime.now()
day_of_week = now.strftime('%A')
date_str = now.strftime('%Y-%m-%d')

output_lines = []
output_lines.append(f"---")
output_lines.append(f"📊 *ANÁLISIS AMPLIADO — {day_of_week} {date_str}*")
output_lines.append("")
output_lines.append("")

# Extreme oversold: RSI < 25
if extreme:
    output_lines.append("🔴 *SOBRESVENDIDOS EXTREMOS — COMPRA!* (RSI < 25)")
    for data in extreme:
        ticker = data['ticker']
        name = data['name']
        price = data['price']
        change = data['change']
        rsi = data['rsi']
        pe = data['pe']
        # We need to get recent news for fundamentals. We'll try to get earnings and FCE data via fallback search.
        # For now, we'll leave placeholder and then try to fill.
        output_lines.append(f"[{ticker}] 0 ({change:+.2f}%) | RSI {rsi:.1f}")
        output_lines.append(f"- P/E {pe:.1f} vs Promedio Sector/Histórico")
        # We'll try to get recent earnings and FCE data using the fallback search script.
        # We'll do a search for "{ticker} earnings" and "{ticker} free cash flow" and take the first result.
        # But we'll do that later in a separate step to avoid slowing down.
        output_lines.append("- Datos FCE/Earnings recientes relevantes")
        output_lines.append("- *Fundamento:* Análisis técnico/fundamental breve")
        output_lines.append("- *Recomendación:* Acción sugerida con soportes y resistencias")
        output_lines.append("")
else:
    output_lines.append("🔴 *SOBRESVENDIDOS EXTREMOS — COMPRA!* (RSI < 25)")
    output_lines.append("No hay tickers en esta categoría.")
    output_lines.append("")

# Oversold: RSI 25-35
if oversold:
    output_lines.append("⚠️ *SOBRESVENDIDOS — CONSIDERAR COMPRA* (RSI 25-35)")
    for data in oversold:
        ticker = data['ticker']
        name = data['name']
        price = data['price']
        change = data['change']
        rsi = data['rsi']
        output_lines.append(f"[{ticker}] 0 ({change:+.2f}%) | RSI {rsi:.1f}")
        output_lines.append("- *Noticias:* Hechos recientes, analistas, movimientos de ballenas como Cathie Wood")
        output_lines.append("- *Fundamento:* Análisis de soportes/SMA50")
        output_lines.append("- *Recomendación:* Sugerencia de entrada o acumulación")
        output_lines.append("")
else:
    output_lines.append("⚠️ *SOBRESVENDIDOS — CONSIDERAR COMPRA* (RSI 25-35)")
    output_lines.append("No hay tickers en esta categoría.")
    output_lines.append("")

# Neutral: RSI 35-65
if neutral:
    output_lines.append("🟡 *NEUTROS / HOLD — MANTENER* (RSI 35-65)")
    # We want a short list of the most relevant tickers in neutral state.
    # We'll take the first 5 by RSI (or maybe by market cap?) but let's just take first 5.
    for data in neutral[:5]:
        ticker = data['ticker']
        price = data['price']
        rsi = data['rsi']
        output_lines.append(f"- {ticker}: ${price:.2f} | RSI {rsi:.1f}")
    output_lines.append("")
else:
    output_lines.append("🟡 *NEUTROS / HOLD — MANTENER* (RSI 35-65)")
    output_lines.append("")
    output_lines.append("")

# Overbought: RSI > 70
if overbought:
    output_lines.append("🔴 *SOBRECOMPRADOS — TOMA DE GANANCIAS* (RSI > 70)")
    for data in overbought:
        ticker = data['ticker']
        price = data['price']
        rsi = data['rsi']
        output_lines.append(f"- [{ticker}] - 0 - RSI {rsi:.1f} - Breve nota de cautela")
    output_lines.append("")
else:
    output_lines.append("🔴 *SOBRECOMPRADOS — TOMA DE GANANCIAS* (RSI > 70)")
    output_lines.append("")
    output_lines.append("")

# Summary
output_lines.append("*=== RESUMEN ===")
output_lines.append("Análisis macro de 2-3 oraciones sobre la tendencia del mercado y el sector tech/Chile/Crypto")
output_lines.append("")

output_lines.append("---")

print("\n".join(output_lines))
