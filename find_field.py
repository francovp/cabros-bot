import sys
sys.path.insert(0, '/home/ubuntu/.openclaw/workspace/skills/tradingview-screener/.venv/lib/python3.12/site-packages')
from tvscreener import StockField
print("Searching for 'symbol':")
results = StockField.search('symbol')
for r in results:
    print(r)
print("\nSearching for 'SYMBOL':")
results = StockField.search('SYMBOL')
for r in results:
    print(r)
print("\nAll fields containing 'symbol' (case insensitive):")
for attr in dir(StockField):
    if 'symbol' in attr.lower():
        print(attr, getattr(StockField, attr))
