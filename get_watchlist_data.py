import sys
sys.path.insert(0, '/home/ubuntu/.openclaw/workspace/skills/tradingview-screener')
from tvscreener import StockScreener
from screener_constants import StockField
import pandas as pd

# Read watchlist from file
with open('memory/watchlist-stocks.md') as f:
    lines = f.readlines()

tickers = []
for line in lines:
    line = line.strip()
    if line.startswith('- ') and ':' in line:
        ticker = line[2:].strip()
        tickers.append(ticker)

print(f"Watchlist has {len(tickers)} tickers", file=sys.stderr)

# Get top 150 stocks by market cap (default sort)
screener = StockScreener()
screener.select(
    StockField.ACTIVE_SYMBOL,
    StockField.NAME,
    StockField.PRICE,
    StockField.CHANGE_PERCENT,
    StockField.RSI9,
    StockField.PRICE_EARNINGS_CURRENT,
    StockField.SIMPLE_MOVING_AVERAGE_50
)
# No filters, so we get the top 150 by market cap (default)
df = screener.get()

print(f"Got {len(df)} rows from screener", file=sys.stderr)

# Filter to our watchlist
df = df[df[StockField.ACTIVE_SYMBOL].isin(tickers)]

print(f"After filtering to watchlist: {len(df)} rows", file=sys.stderr)

if df.empty:
    print("No data found for watchlist tickers", file=sys.stderr)
    sys.exit(1)

# Sort by RSI9 ascending (so lowest RSI first)
df = df.sort_values(by=StockField.RSI9, ascending=True)

# Output as CSV for easy reading
print("symbol,name,price,change_percent,rsi9,pe,sma50")
for _, row in df.iterrows():
    symbol = row[StockField.ACTIVE_SYMBOL]
    name = row[StockField.NAME]
    price = row[StockField.PRICE]
    change = row[StockField.CHANGE_PERCENT]
    rsi9 = row[StockField.RSI9]
    pe = row[StockField.PRICE_EARNINGS_CURRENT]
    sma50 = row[StockField.SIMPLE_MOVING_AVERAGE_50]
    # Handle NaN values
    if pd.isna(price):
        price = "N/A"
    if pd.isna(change):
        change = "N/A"
    if pd.isna(rsi9):
        rsi9 = "N/A"
    if pd.isna(pe):
        pe = "N/A"
    if pd.isna(sma50):
        sma50 = "N/A"
    print(f"{symbol},{name},{price},{change},{rsi9},{pe},{sma50}")
