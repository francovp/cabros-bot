import tvscreener as tvs
import re
import pandas as pd

# Read watchlist
with open('memory/watchlist-stocks.md') as f:
    content = f.read()
pattern = r'\b([A-Z]+:[A-Z0-9\.]+)\b'
tickers = re.findall(pattern, content)
print(f'Total tickers in watchlist: {len(tickers)}')

# Process in chunks to avoid API limits
chunk_size = 20
all_dfs = []

for i in range(0, len(tickers), chunk_size):
    chunk = tickers[i:i+chunk_size]
    print(f'Processing chunk {i//chunk_size + 1}: {len(chunk)} tickers')
    
    screener = tvs.StockScreener()
    screener.where(tvs.StockField.ACTIVE_SYMBOL.isin(chunk))
    screener.select(
        tvs.StockField.ACTIVE_SYMBOL,
        tvs.StockField.PRICE,
        tvs.StockField.CHANGE_PERCENT,
        tvs.StockField.RSI9,
        tvs.StockField.PRICE_TO_EARNINGS_RATIO_TTM,
        tvs.StockField.SIMPLE_MOVING_AVERAGE_50
    )
    
    try:
        df_chunk = screener.get()
        if not df_chunk.empty:
            all_dfs.append(df_chunk)
            print(f'  -> got {len(df_chunk)} rows')
        else:
            print('  -> no data for this chunk')
    except Exception as e:
        print(f'  -> error: {e}')

if all_dfs:
    df = pd.concat(all_dfs, ignore_index=True)
    # Remove duplicates (if any ticker appears in multiple chunks due to overlap, but we didn't overlap)
    df = df.drop_duplicates(subset=['active_symbol'])
    print(f'\nTotal unique rows: {len(df)}')
    print(df.head())
else:
    df = pd.DataFrame()
    print('No data retrieved')

# Save to CSV for inspection
df.to_csv('watchlist_data.csv', index=False)
print('Data saved to watchlist_data.csv')