from tvscreener import StockScreener
import pandas as pd
import re
import time

# Get watchlist symbols from file
with open('/home/ubuntu/.openclaw/workspace/memory/watchlist-stocks.md', 'r') as f:
    content = f.read()
tickers = re.findall(r'^\s*-\s+(\S+)', content, re.MULTILINE)
watchlist = [t for t in tickers if t.startswith('NASDAQ:') or t.startswith('NYSE:')]
print('Watchlist symbols:', len(watchlist))

# Fetch data in batches to avoid limits
batch_size = 200
all_data = []
start = 0
while True:
    screener = StockScreener()
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
            rename_map['Price'] = 'Price'
        if 'Relative Strength Index (14)' in filtered.columns:
            rename_map['Relative Strength Index (14)'] = 'RSI'
        filtered = filtered.rename(columns=rename_map)
        print('First 5 rows:')
        print(filtered.head())
        # Save to CSV
        output_path = '/home/ubuntu/.openclaw/workspace/watchlist_data.csv'
        filtered.to_csv(output_path, index=False)
        print('Saved to', output_path)
    else:
        print('No watchlist stocks found in fetched data')
else:
    print('No data fetched')
