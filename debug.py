import sys
sys.path.insert(0, '/home/ubuntu/.openclaw/workspace/skills/tradingview-screener/.venv/lib/python3.12/site-packages')
from tvscreener import StockScreener, StockField

tickers = ['NYSE:CCU', 'NYSE:BSAC', 'NYSE:GLD', 'NYSE:BCH']
symbols = {"query": {"types": []}, "tickers": tickers}
sc = StockScreener()
sc.symbols = symbols
sc.select(StockField.ACTIVE_SYMBOL, StockField.NAME, StockField.PRICE, StockField.CHANGE_PERCENT, StockField.RSI9)
df = sc.get()
print("Columns:", df.columns.tolist())
print("Data:")
print(df.head())
print("\nFirst row as dict:")
print(df.iloc[0].to_dict())
