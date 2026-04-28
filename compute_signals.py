import sys
sys.path.insert(0, '/home/ubuntu/.openclaw/workspace/skills/tradingview-screener/.venv/lib/python3.12/site-packages')
from tvscreener import StockScreener, StockField
import pandas as pd

# Full watchlist from the original script
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

# Ensure we have the data
print(f"Fetched {len(df)} rows", file=sys.stderr)

# Define thresholds
extreme_oversold = df[df['Rsi9'] < 25]
oversold = df[(df['Rsi9'] >= 25) & (df['Rsi9'] < 35)]
neutral = df[(df['Rsi9'] >= 35) & (df['Rsi9'] <= 65)]
overbought = df[df['Rsi9'] > 70]

# Prepare report lines
lines = []
lines.append("---")
# Get current day and date
from datetime import datetime
now = datetime.now()
# Day of week in Spanish? The user is Chilean, but the example uses English day? We'll use English as in the example.
day_str = now.strftime("%A")  # Monday, Tuesday, etc.
date_str = now.strftime("%Y-%m-%d")
lines.append(f"📊 *ANÁLISIS AMPLIADO — {day_str} {date_str}*")
lines.append("")

# Extreme oversold: RSI < 25
lines.append("*🔴 SOBRESVENDIDOS EXTREMOS — COMPRA!* (RSI < 25)")
if extreme_oversold.empty:
    lines.append("Ningún ticker en la watchlist cumple con este criterio.")
else:
    for _, row in extreme_oversold.iterrows():
        ticker = row['Name']
        price = row['Price']
        change = row['Change %']
        rsi = row['Rsi9']
        pe = row['Price to Earnings Ratio (TTM)']
        lines.append(f"[{ticker}] 0 ({change:+.2f}%) | RSI {rsi:.1f}")
        # P/E line
        lines.append(f"- P/E {pe:.1f} vs Promedio Sector/Histórico")
        # We need FCE/Earnings data from fallback search. We'll do that later for each ticker.
        # For now, placeholder.
        lines.append("- Datos FCE/Earnings recientes relevantes")
        lines.append("- *Fundamento:* Análisis técnico/fundamental breve")
        lines.append("- *Recomendación:* Acción sugerida con soportes y resistencias")
        lines.append("")  # empty line between tickers? The format shows each ticker block separated by blank line? In example, each ticker block has bullets and then a blank line before next ticker? Actually looking at the format, each ticker block is a set of lines, and then next ticker block starts. We'll add a blank line after each ticker block except last.
    # Remove the last extra blank line? We'll handle by not adding after last.
# But we need to avoid double blank lines. Let's rebuild.

# Let's instead build per ticker and then join.

# We'll redo the building more carefully.

lines = []
lines.append("---")
lines.append(f"📊 *ANÁLISIS AMPLIADO — {day_str} {date_str}*")
lines.append("")

def format_ticker_block(ticker, price, change, rsi, pe, news_fallback=None):
    block = []
    block.append(f"[{ticker}] 0 ({change:+.2f}%) | RSI {rsi:.1f}")
    block.append(f"- P/E {pe:.1f} vs Promedio Sector/Histórico")
    # For FCE/Earnings, we need to get from fallback search. We'll call a function later.
    # For now, we'll put a placeholder and later replace.
    block.append("- Datos FCE/Earnings recientes relevantes")
    block.append("- *Fundamento:* Análisis técnico/fundamental breve")
    block.append("- *Recomendación:* Acción sugerida con soportes y resistencias")
    return block

# Extreme oversold
lines.append("*🔴 SOBRESVENDIDOS EXTREMOS — COMPRA!* (RSI < 25)")
if extreme_oversold.empty:
    lines.append("Ningún ticker en la watchlist cumple con este criterio.")
else:
    first = True
    for _, row in extreme_oversold.iterrows():
        if not first:
            lines.append("")  # blank line between ticker blocks
        first = False
        ticker = row['Name']
        price = row['Price']
        change = row['Change %']
        rsi = row['Rsi9']
        pe = row['Price to Earnings Ratio (TTM)']
        # We'll get fallback data for this ticker later
        lines.extend(format_ticker_block(ticker, price, change, rsi, pe))
lines.append("")

# Oversold: RSI 25-35
lines.append("*⚠️ SOBRESVENDIDOS — CONSIDERAR COMPRA* (RSI 25-35)")
if oversold.empty:
    lines.append("Ningún ticker en la watchlist cumple con este criterio.")
else:
    first = True
    for _, row in oversold.iterrows():
        if not first:
            lines.append("")
        first = False
        ticker = row['Name']
        price = row['Price']
        change = row['Change %']
        rsi = row['Rsi9']
        pe = row['Price to Earnings Ratio (TTM)']
        # For this section, we need news instead of P/E line? According to format:
        # - *Noticias:* [Hechos recientes, analistas, movimientos de ballenas como Cathie Wood]
        # - *Fundamento:* [Análisis de soportes/SMA50]
        # So we need to change the block for this section.
        # We'll handle separately.
        sma50 = row.get('Simple Moving Average (50)', None)
        note = ""
        if sma50 and price < sma50:
            note = " | Precio bajo SMA50"
        lines.append(f"[{ticker}] 0 ({change:+.2f}%) | RSI {rsi:.1f}{note}")
        # We'll get news via fallback search
        lines.append("- *Noticias:* [Hechos recientes, analistas, movimientos de ballenas como Cathie Wood]")
        lines.append("- *Fundamento:* [Análisis de soportes/SMA50]")
        lines.append("- *Recomendación:* [Sugerencia de entrada o acumulación]")
lines.append("")

# Neutral / Hold
lines.append("*🟡 NEUTROS / HOLD — MANTENER* (RSI 35-65)")
if neutral.empty:
    lines.append("Ningún ticker en la watchlist cumple con este criterio.")
else:
    # Listado corto de los tickers más relevantes de la watchlist en estado neutral con su precio y RSI
    # We'll list maybe top 5 by RSI closeness to 50? Or just first few.
    # We'll sort by RSI and take first 5.
    neutral_sorted = neutral.sort_values('Rsi9')
    for _, row in neutral_sorted.head().iterrows():
        ticker = row['Name']
        price = row['Price']
        rsi = row['Rsi9']
        lines.append(f"- {ticker}: ${price:.2f} | RSI {rsi:.1f}")
lines.append("")

# Overbought: RSI > 70
lines.append("*🔴 SOBRECOMPRADOS — TOMA DE GANANCIAS* (RSI > 70)")
if overbought.empty:
    lines.append("Ningún ticker en la watchlist cumple con este criterio.")
else:
    first = True
    for _, row in overbought.iterrows():
        if not first:
            lines.append(" - ")  # The format shows " - " between ticker and RSI? Actually example: "[TICKER] - 0 - RSI [VALOR] - [Breve nota de cautela]"
            # So we need to output: TICKER - 0 - RSI VALUE - note
        first = False
        ticker = row['Name']
        price = row['Price']
        change = row['Change %']
        rsi = row['Rsi9']
        lines.append(f"{ticker} - 0 - RSI {rsi:.1f} - [Breve nota de cautela]")
lines.append("")

# Resumen
lines.append("*=== RESUMEN ===")
lines.append("[Análisis macro de 2-3 oraciones sobre la tendencia del mercado y el sector tech/Chile/Crypto]")
lines.append("---")

# Now we need to fill in the fallback data for news and FCE/Earnings.
# We'll do that by calling the search script for each ticker in extreme oversold and oversold sections.
# But we only have oversold section with data (NFLX and BRK.A). Extreme oversold is empty.
# So we only need to get news for NFLX and BRK.A, and FCE/Earnings data? Actually for oversold section we need news.
# For extreme oversold we need FCE/Earnings data, but none.

# Let's define a function to get news using the fallback script.
import subprocess
import json

def get_news_for_ticker(ticker):
    # Use the search_fallback_curl.sh script
    query = f"{ticker} earnings revenue P/E FCE April 2026"
    try:
        result = subprocess.run(['/home/ubuntu/.openclaw/workspace/scripts/search_fallback_curl.sh', query],
                                capture_output=True, text=True, timeout=30)
        output = result.stdout
        # Extract first meaningful line? We'll just take the first title from Tavily output.
        # The script outputs a bunch of lines. We'll parse for "Título:" lines.
        lines = output.split('\n')
        titles = []
        for line in lines:
            if line.startswith('Título:'):
                titles.append(line.replace('Título:', '').strip())
        if titles:
            return '; '.join(titles[:2])  # first two titles
        else:
            return "No se encontraron noticias recientes."
    except Exception as e:
        return f"Error al buscar noticias: {e}"

def get_fce_earnings_for_ticker(ticker):
    query = f"{ticker} free cash flow earnings revenue April 2026"
    try:
        result = subprocess.run(['/home/ubuntu/.openclaw/workspace/scripts/search_fallback_curl.sh', query],
                                capture_output=True, text=True, timeout=30)
        output = result.stdout
        lines = output.split('\n')
        titles = []
        for line in lines:
            if line.startswith('Título:'):
                titles.append(line.replace('Título:', '').strip())
        if titles:
            return '; '.join(titles[:2])
        else:
            return "No se encontraron datos recientes de FCE o earnings."
    except Exception as e:
        return f"Error al buscar FCE/earnings: {e}"

# Now we need to replace the placeholder lines in the blocks we built.
# This is getting complex. Instead, let's regenerate the report with actual data by calling the search functions during building.

# Let's start over and build the report with actual data.

# We'll create a new script that builds the report directly.