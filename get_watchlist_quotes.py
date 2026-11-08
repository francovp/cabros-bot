import sys
sys.path.insert(0, 'skills/tradingview-screener')
from tvscreener import StockScreener
import pandas as pd
import re

# Get watchlist symbols from file
with open('memory/watchlist-stocks.md', 'r') as f:
    content = f.read()
tickers = re.findall(r'^\s*-\s+(\S+)', content, re.MULTILINE)
watchlist = [t for t in tickers if t.startswith('NASDAQ:') or t.startswith('NYSE:')]
print('Watchlist symbols:', len(watchlist))

# We'll fetch data in batches of 200 (max range seems to be 200? Actually, the range is 0-150 by default, but we can try larger)
# Let's try to get the first 500 stocks by doing multiple batches.
batch_size = 200
all_data = []
start = 0
while True:
    screener = StockScreener()
    # We want columns: Symbol, Name, Price, Relative Strength Index (14)
    screener.select('Symbol', 'Name', 'Price', 'Relative Strength Index (14)')
    screener.range(start, start + batch_size - 1)
    data = screener.get()
    if data.empty:
        break
    all_data.append(data)
    print('Fetched {} rows from {} to {}'.format(len(data), start, start+len(data)-1))
    if len(data) < batch_size:
        break
    start += len(data)

if all_data:
    df = pd.concat(all_data, ignore_index=True)
    df.columns = [col.strip() for col in df.columns]
    print('Total rows fetched:', len(df))
    # Filter to watchlist
    mask = df['Symbol'].isin(watchlist)
    filtered = df[mask]
    print('Found {} watchlist stocks'.format(len(filtered)))
    if len(filtered) > 0:
        # Ensure we have the columns we need
        cols_needed = ['Symbol', 'Name', 'Price', 'Relative Strength Index (14)']
        available = [c for c in cols_needed if c in filtered.columns]
        print('Available columns:', available)
        # Select only available columns
        filtered = filtered[available]
        # Rename for convenience
        rename_map = {}
        if 'Symbol' in filtered.columns:
            rename_map['Symbol'] = 'Ticker'
        if 'Name' in filtered.columns:
            rename_map['Name'] = 'Name'
        if 'Price' in filtered.columns:
            rename_map['Price'] = 'Price (USD)'
        if 'Relative Strength Index (14)' in filtered.columns:
            rename_map['Relative Strength Index (14)'] = 'RSI'
        filtered = filtered.rename(columns=rename_map)
        print('')
        print('First 10 rows:')
        print(filtered.head(10))
        # Save to CSV
        output_path = 'watchlist_data.csv'
        filtered.to_csv(output_path, index=False)
        print('')
        print('Saved to {}'.format(output_path))
    else:
        print('No watchlist stocks found in fetched data')
else:
    print('No data fetched')
