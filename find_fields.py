import sys
sys.path.insert(0, '/home/ubuntu/.openclaw/workspace/skills/tradingview-screener/.venv/lib/python3.12/site-packages')
from tvscreener import StockField

def search_and_print(keyword):
    print(f"\nSearching for '{keyword}':")
    try:
        results = StockField.search(keyword)
        for r in results:
            print(f"  {r}")
    except Exception as e:
        print(f"  Error: {e}")

keywords = ['Symbol', 'Ticker', 'Name', 'Price', 'Change', 'RSI', 'PE', 'Earnings', 'Moving Average', 'Free Cash Flow']
for kw in keywords:
    search_and_print(kw)

# Also let's list some fields that might be relevant
print("\n\nSome fields that might be the ticker symbol:")
for attr in dir(StockField):
    if 'symbol' in attr.lower() and not attr.startswith('_'):
        print(f"  {attr}: {getattr(StockField, attr)}")
