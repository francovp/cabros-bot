#!/usr/bin/env python3
"""Fetch full technical data for watchlist stocks."""
import sys
import re
import pandas as pd
from tvscreener import StockScreener, StockField

# Get watchlist symbols from file
with open('/home/ubuntu/.openclaw/workspace/memory/watchlist-stocks.md', 'r') as f:
    content = f.read()
tickers = re.findall(r'^\s*-\s+(\S+)', content, re.MULTILINE)
watchlist = [t for t in tickers if t.startswith('NASDAQ:') or t.startswith('NYSE:')]
print(f'Watchlist symbols: {len(watchlist)}')
print(watchlist)

# Also get crypto and forex tickers
crypto_tickers = [t for t in tickers if t.startswith('BINANCE:')]
forex_tickers = [t for t in tickers if t.startswith('FX_IDC:')]
index_tickers = [t for t in tickers if t.startswith('NASDAQ:NDX') or t.startswith('SP:SPX') or t.startswith('AMEX:GLD') or t.startswith('AMEX:SLV')]

print(f'Crypto: {crypto_tickers}')
print(f'Forex: {forex_tickers}')
print(f'Indexes: {index_tickers}')

# Define fields to fetch
fields = [
    StockField.ACTIVE_SYMBOL,
    StockField.NAME,
    StockField.PRICE,
    StockField.CHANGE_PERCENT,
    StockField.VOLUME,
    StockField.RELATIVE_STRENGTH_INDEX_14,
    StockField.SMA20_1,  # Daily SMA20
    StockField.MACD_LEVEL_12_26,
    StockField.MACD_SIGNAL_12_26,
    StockField.ATR_1,  # Daily ATR
]

# Fetch in batches
batch_size = 1
all_data = []
for i in range(0, len(watchlist), batch_size):
    batch = watchlist[i:i+batch_size]
    print(f'\nFetching batch {i//batch_size + 1}: {batch}')
    
    screener = StockScreener()
    screener.where(StockField.ACTIVE_SYMBOL.isin(batch))
    screener.select(*fields)
    data = screener.get()
    
    if not data.empty:
        all_data.append(data)
        print(f'  Got {len(data)} rows')
    else:
        print(f'  No data')

if all_data:
    df = pd.concat(all_data, ignore_index=True)
    df.columns = [col.strip() for col in df.columns]
    print(f'\nTotal rows fetched: {len(df)}')
    print(df.head())
    
    # Save to CSV
    output_path = '/home/ubuntu/.openclaw/workspace/watchlist_full_data.csv'
    df.to_csv(output_path, index=False)
    print(f'Saved to {output_path}')
else:
    print('No data fetched')

# Now fetch crypto
print('\n--- Fetching Crypto ---')
from tvscreener import CryptoScreener, CryptoField
crypto_fields = [
    CryptoField.ACTIVE_SYMBOL,
    CryptoField.NAME,
    CryptoField.PRICE,
    CryptoField.CHANGE_PERCENT,
    CryptoField.VOLUME,
    CryptoField.RELATIVE_STRENGTH_INDEX_14,
    CryptoField.SMA20_1,
    CryptoField.MACD_LEVEL_12_26,
    CryptoField.MACD_SIGNAL_12_26,
    CryptoField.ATR_1,
]

crypto_data = []
for i in range(0, len(crypto_tickers), batch_size):
    batch = crypto_tickers[i:i+batch_size]
    print(f'Fetching crypto batch: {batch}')
    
    screener = CryptoScreener()
    screener.where(CryptoField.ACTIVE_SYMBOL.isin(batch))
    screener.select(*crypto_fields)
    data = screener.get()
    
    if not data.empty:
        crypto_data.append(data)
        print(f'  Got {len(data)} rows')

if crypto_data:
    crypto_df = pd.concat(crypto_data, ignore_index=True)
    crypto_df.columns = [col.strip() for col in crypto_df.columns]
    print(f'Total crypto rows: {len(crypto_df)}')
    crypto_df.to_csv('/home/ubuntu/.openclaw/workspace/crypto_data.csv', index=False)
    print('Saved crypto data')

# Fetch forex
print('\n--- Fetching Forex ---')
from tvscreener import ForexScreener, ForexField
forex_fields = [
    ForexField.ACTIVE_SYMBOL,
    ForexField.NAME,
    ForexField.PRICE,
    ForexField.CHANGE_PERCENT,
    ForexField.RELATIVE_STRENGTH_INDEX_14,
    ForexField.SMA20_1,
    ForexField.MACD_LEVEL_12_26,
    ForexField.MACD_SIGNAL_12_26,
    ForexField.ATR_1,
]

forex_data = []
for i in range(0, len(forex_tickers), batch_size):
    batch = forex_tickers[i:i+batch_size]
    print(f'Fetching forex batch: {batch}')
    
    screener = ForexScreener()
    screener.where(ForexField.ACTIVE_SYMBOL.isin(batch))
    screener.select(*forex_fields)
    data = screener.get()
    
    if not data.empty:
        forex_data.append(data)
        print(f'  Got {len(data)} rows')

if forex_data:
    forex_df = pd.concat(forex_data, ignore_index=True)
    forex_df.columns = [col.strip() for col in forex_df.columns]
    print(f'Total forex rows: {len(forex_df)}')
    forex_df.to_csv('/home/ubuntu/.openclaw/workspace/forex_data.csv', index=False)
    print('Saved forex data')

# Fetch indexes
print('\n--- Fetching Indexes ---')
index_data = []
for i in range(0, len(index_tickers), batch_size):
    batch = index_tickers[i:i+batch_size]
    print(f'Fetching index batch: {batch}')
    
    screener = StockScreener()
    screener.where(StockField.ACTIVE_SYMBOL.isin(batch))
    screener.select(*fields)
    data = screener.get()
    
    if not data.empty:
        index_data.append(data)
        print(f'  Got {len(data)} rows')

if index_data:
    index_df = pd.concat(index_data, ignore_index=True)
    index_df.columns = [col.strip() for col in index_df.columns]
    print(f'Total index rows: {len(index_df)}')
    index_df.to_csv('/home/ubuntu/.openclaw/workspace/index_data.csv', index=False)
    print('Saved index data')