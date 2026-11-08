from tvscreener import StockScreener
import pandas as pd
import re

# Get watchlist symbols from file (absolute path)
with open('/home/ubuntu/.openclaw/workspace/memory/watchlist-stocks.md', 'r') as f:
    content = f.read()
tickers = re.findall(r'^\s*-\s+(\S+)', content, re.MULTILINE)
watchlist = [t for t in tickers if t.startswith('NASDAQ:') or t.startswith('NYSE:')]
print('Watchlist symbols: ' + str(len(watchlist)))

# Fetch data in batches to avoid limits
batch_size = 200
all_data = []
start = 0
while True:
    screener = StockScreener()
    screener.select('Symbol', 'Name', 'Price', 'Relative Strength Index (14)')
    screener.set_range(start, start + batch_size - 1)
    data = screener.get()
    if data.empty:
        break
    all_data.append(data)
    print('Fetched ' + str(len(data)) + ' rows from ' + str(start) + ' to ' + str(start+len(data)-1))
    if len(data) < batch_size:
        break
    start += len(data)

if all_data:
    df = pd.concat(all_data, ignore_index=True)
    df.columns = [col.strip() for col in df.columns]
    print('Total rows fetched: ' + str(len(df)))
    # Filter to watchlist
    mask = df['Symbol'].isin(watchlist)
    filtered = df[mask]
    print('Found ' + str(len(filtered)) + ' watchlist stocks')
    if len(filtered) > 0:
        print('')
        print('First 10 rows:')
        print(filtered[['Symbol', 'Name', 'Price', 'Relative Strength Index (14)']].head(10))
        # Save to CSV in workspace
        output_path = '/home/ubuntu/.openclaw/workspace/watchlist_data.csv'
        filtered.to_csv(output_path, index=False)
        print('')
        print('Saved to ' + output_path)
    else:
        print('No watchlist stocks found in fetched data')
else:
    print('No data fetched')
