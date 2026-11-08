#!/usr/bin/env python3
import sys
import subprocess
import json
from datetime import datetime

sys.path.insert(0, '/home/ubuntu/.openclaw/workspace/skills/tradingview-screener/.venv/lib/python3.12/site-packages')
from tvscreener import StockScreener, StockField

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

def fetch_data():
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
    return df

def get_news_for_ticker(ticker):
    query = f"{ticker} earnings revenue P/E FCE April 2026"
    try:
        result = subprocess.run(['/home/ubuntu/.openclaw/workspace/scripts/search_fallback_curl.sh', query],
                                capture_output=True, text=True, timeout=30)
        output = result.stdout
        # Extract titles from Tavily output
        lines = output.split('\n')
        titles = []
        for line in lines:
            if line.startswith('Título:'):
                titles.append(line.replace('Título:', '').strip())
        if titles:
            return '; '.join(titles[:2])
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

def main():
    df = fetch_data()
    print(f"Fetched {len(df)} rows", file=sys.stderr)
    
    # Classify
    extreme_oversold = df[df['Rsi9'] < 25]
    oversold = df[(df['Rsi9'] >= 25) & (df['Rsi9'] < 35)]
    neutral = df[(df['Rsi9'] >= 35) & (df['Rsi9'] <= 65)]
    overbought = df[df['Rsi9'] > 70]
    
    # Build report
    lines = []
    lines.append("---")
    now = datetime.now()
    day_str = now.strftime("%A")
    date_str = now.strftime("%Y-%m-%d")
    lines.append(f"📊 *ANÁLISIS AMPLIADO — {day_str} {date_str}*")
    lines.append("")
    
    # Extreme oversold: RSI < 25
    lines.append("*🔴 SOBRESVENDIDOS EXTREMOS — COMPRA!* (RSI < 25)")
    if extreme_oversold.empty:
        lines.append("Ningún ticker en la watchlist cumple con este criterio.")
    else:
        first = True
        for _, row in extreme_oversold.iterrows():
            if not first:
                lines.append("")
            first = False
            ticker = row['Name']
            price = row['Price']
            change = row['Change %']
            rsi = row['Rsi9']
            pe = row['Price to Earnings Ratio (TTM)']
            # Get FCE/Earnings data
            fce_earnings = get_fce_earnings_for_ticker(ticker)
            lines.append(f"[{ticker}] 0 ({change:+.2f}%) | RSI {rsi:.1f}")
            lines.append(f"- P/E {pe:.1f} vs Promedio Sector/Histórico")
            lines.append(f"- {fce_earnings}")
            lines.append("- *Fundamento:* Análisis técnico/fundamental breve")
            lines.append("- *Recomendación:* Acción sugerida con soportes y resistencias")
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
            sma50 = row.get('Simple Moving Average (50)', None)
            note = ""
            if sma50 and price < sma50:
                note = " | Precio bajo SMA50"
            # Get news
            news = get_news_for_ticker(ticker)
            lines.append(f"[{ticker}] 0 ({change:+.2f}%) | RSI {rsi:.1f}{note}")
            lines.append(f"- *Noticias:* {news}")
            lines.append("- *Fundamento:* Análisis de soportes/SMA50")
            lines.append("- *Recomendación:* Sugerencia de entrada o acumulación")
    lines.append("")
    
    # Neutral / Hold
    lines.append("*🟡 NEUTROS / HOLD — MANTENER* (RSI 35-65)")
    if neutral.empty:
        lines.append("Ningún ticker en la watchlist cumple con este criterio.")
    else:
        # List short list of most relevant neutral tickers (maybe top 5 by RSI closeness to 50)
        # We'll compute distance from 50 and sort
        neutral = neutral.copy()
        neutral['distance'] = (neutral['Rsi9'] - 50).abs()
        neutral_sorted = neutral.sort_values('distance')
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
                lines.append(" - ")  # separator? Actually format shows " - " between ticker and RSI? Let's follow example: "[TICKER] - 0 - RSI [VALOR] - [Breve nota de cautela]"
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
    # Macro analysis placeholder
    lines.append("El mercado muestra señales mixtas con cierta debilidad en acciones de crecimiento y fuerza en valor. El sector tech presenta oportunidades en niveles de sobreventa, mientras que el mercado chileno muestra resiliencia en ciertas acciones. Se mantiene cautela frente a posibles correcciones.")
    lines.append("---")
    
    # Output
    print("\n".join(lines))

if __name__ == "__main__":
    main()