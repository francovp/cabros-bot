#!/usr/bin/env python3
import sys
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
    StockField.NAME, StockField.PRICE, StockField.CHANGE_PERCENT, StockField.RSI9,
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
    rsi = row['Rsi9']
    data = {
        'ticker': row['Name'],  # Actually Name column is the display name? We need symbol. Let's also get SYMBOL.
        # We didn't select SYMBOL. We'll need to add it.
    }
# We need to reselect with SYMBOL.
