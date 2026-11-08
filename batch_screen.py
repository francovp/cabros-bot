import tvscreener as tvs
import sys
import time

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
field = tvs.StockField

# We'll process in chunks of 5 to be safe
chunk_size = 5

# Print header
print("symbol,name,price,change_percent,rsi9,pe,sma50")

for i in range(0, len(tickers), chunk_size):
    chunk = tickers[i:i+chunk_size]
    # print(f"Processing chunk {i//chunk_size + 1}: {len(chunk)} tickers", file=sys.stderr)
    
    # Create a new screener for each chunk
    s = tvs.StockScreener()
    s.where(field.ACTIVE_SYMBOL.isin(chunk))
    s.select(
        field.ACTIVE_SYMBOL,
        field.NAME,
        field.PRICE,
        field.CHANGE_PERCENT,
        field.RSI9,
        field.PRICE_EARNINGS_CURRENT,
        field.SIMPLE_MOVING_AVERAGE_50
    )
    try:
        df = s.get()
        if not df.empty:
            for _, row in df.iterrows():
                symbol = row['ACTIVE_SYMBOL']
                name = row['NAME']
                price = row['PRICE']
                change = row['CHANGE_PERCENT']
                rsi9 = row['RSI9']
                pe = row['PRICE_EARNINGS_CURRENT']
                sma50 = row['SIMPLE_MOVING_AVERAGE_50']
                print(f"{symbol},{name},{price},{change},{rsi9},{pe},{sma50}")
    except Exception as e:
        print(f"Error processing chunk starting at {chunk[0] if chunk else 'unknown'}: {e}", file=sys.stderr)
    # Be gentle with the API
    time.sleep(0.5)
