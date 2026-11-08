import tvscreener as tvs
import sys

# Read watchlist from file
with open('memory/watchlist-stocks.md') as f:
    lines = f.readlines()

tickers = []
for line in lines:
    line = line.strip()
    if line.startswith('- ') and ':' in line:
        ticker = line[2:].strip()
        tickers.append(ticker)

print(f"Found {len(tickers)} tickers", file=sys.stderr)

# Build screener for stock
screener = tvs.StockScreener()
field = tvs.StockField

# Filter: symbols in watchlist
screener.where(field.ACTIVE_SYMBOL.isin(tickers))

# Select columns: symbol, price, change percent, RSI9, P/E, SMA50
# We need to check the exact field names for RSI9 and SMA50 and P/E
# Let's try: RSI9, PRICE_EARNINGS_CURRENT, SIMPLE_MOVING_AVERAGE_50
screener.select(
    field.NAME,
    field.PRICE,
    field.CHANGE_PERCENT,
    field.RSI9,  # RSI 9
    field.PRICE_EARNINGS_CURRENT,  # P/E TTM
    field.SIMPLE_MOVING_AVERAGE_50  # SMA 50
)

# Get data
df = screener.get()

# Print as CSV for easy reading
print("symbol,name,price,change_percent,rsi9,pe,sma50")
for _, row in df.iterrows():
    print(f"{row['ACTIVE_SYMBOL']},{row['NAME']},{row['PRICE']},{row['CHANGE_PERCENT']},{row['RSI9']},{row['PRICE_EARNINGS_CURRENT']},{row['SIMPLE_MOVING_AVERAGE_50']}")
