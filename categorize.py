import sys
import pandas as pd

# Read the CSV we generated
df = pd.read_csv('/tmp/watchlist_data.csv')

# Convert RSI9 to float, handling N/A
df['rsi9'] = pd.to_numeric(df['rsi9'], errors='coerce')

# Categorize
extreme = df[df['rsi9'] < 25]
oversold = df[(df['rsi9'] >= 25) & (df['rsi9'] <= 35)]
neutral = df[(df['rsi9'] > 35) & (df['rsi9'] <= 65)]
overbought = df[df['rsi9'] > 70]

print("EXTREME OVERSOLD (RSI < 25):")
print(extreme[['symbol', 'price', 'change_percent', 'rsi9', 'pe']].to_string(index=False))
print()
print("OVERSOLD (RSI 25-35):")
print(oversold[['symbol', 'price', 'change_percent', 'rsi9', 'pe']].to_string(index=False))
print()
print("NEUTRAL/HOLD (RSI 35-65):")
print(neutral[['symbol', 'price', 'change_percent', 'rsi9', 'pe']].to_string(index=False))
print()
print("OVERBOUGHT (RSI > 70):")
print(overbought[['symbol', 'price', 'change_percent', 'rsi9', 'pe']].to_string(index=False))
