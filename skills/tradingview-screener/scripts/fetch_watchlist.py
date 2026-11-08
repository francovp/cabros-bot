import sys
sys.path.insert(0, '.')
from screener_constants import SCREENER_MAP, resolve_field
from tvscreener import StockScreener, StockField

def fetch_watchlist():
    asset_class = "stock"
    screener_cls, field_enum = SCREENER_MAP[asset_class]
    screener = screener_cls()

    # Read watchlist from absolute path
    watchlist_path = '/home/ubuntu/.openclaw/workspace/memory/watchlist-stocks.md'
    with open(watchlist_path, 'r') as f:
        content = f.read()
    # Extract tickers (lines starting with '-')
    import re
    tickers = re.findall(r'^\s*-\s+(\S+)', content, re.MULTILINE)
    # Filter only those that start with NASDAQ: or NYSE: (stocks)
    tickers = [t for t in tickers if t.startswith('NASDAQ:') or t.startswith('NYSE:')]
    print(f"Found {len(tickers)} stock tickers in watchlist")

    # We'll fetch in batches
    batch_size = 20
    all_data = []
    for i in range(0, len(tickers), batch_size):
        batch = tickers[i:i+batch_size]
        # Create filter: active_symbol in batch
        screener_tmp = screener_cls()
        screener_tmp.where(field_enum.ACTIVE_SYMBOL.isin(batch))
        # Select columns: we want Symbol (as shown in output), Name, Price, RSI14
        # We need to resolve the field names for columns we want.
        # From the default output we saw columns: 'Symbol', 'Name', 'Price', 'Relative Strength Index (14)'
        # Let's try to resolve these strings to field enums.
        try:
            symbol_field = resolve_field(field_enum, 'SYMBOL')  # but we saw there is no SYMBOL field
        except ValueError:
            # Maybe the column 'Symbol' comes from ACTIVE_SYMBOL? Let's check.
            # In the default output, the column 'Symbol' likely corresponds to the ticker with exchange.
            # We'll use ACTIVE_SYMBOL as the symbol column.
            symbol_field = field_enum.ACTIVE_SYMBOL
        name_field = resolve_field(field_enum, 'NAME')
        price_field = resolve_field(field_enum, 'PRICE')  # or CLOSE? we saw 'Price' column
        # For RSI, let's try to find a field named 'RELATIVE_STRENGTH_INDEX_14' or similar
        rsi_field = None
        for fname in dir(field_enum):
            if not fname.startswith('_') and 'RELATIVE_STRENGTH_INDEX' in fname and '14' in fname:
                rsi_field = getattr(field_enum, fname)
                break
        if rsi_field is None:
            # fallback to RSI10
            rsi_field = resolve_field(field_enum, 'RSI10')
        # Now select
        screener_tmp.select(symbol_field, name_field, price_field, rsi_field)
        data = screener_tmp.get()
        if not data.empty:
            all_data.append(data)
            print(f"Batch {i//batch_size + 1}: got {len(data)} rows")
        else:
            print(f"Batch {i//batch_size + 1}: 0 rows")

    if all_data:
        import pandas as pd
        df = pd.concat(all_data, ignore_index=True)
        # Rename columns for clarity
        df = df.rename(columns={
            symbol_field.name: 'Symbol',
            name_field.name: 'Name',
            price_field.name: 'Price',
            rsi_field.name: 'RSI'
        })
        print(f"\nTotal rows: {len(df)}")
        print(df[['Symbol', 'Name', 'Price', 'RSI']].head(10))
        # Save to CSV in workspace
        output_path = '/home/ubuntu/.openclaw/workspace/watchlist_data.csv'
        df.to_csv(output_path, index=False)
        print(f"Saved to {output_path}")
    else:
        print("No data fetched")

if __name__ == '__main__':
    fetch_watchlist()
