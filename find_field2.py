import sys
sys.path.insert(0, '/home/ubuntu/.openclaw/workspace/skills/tradingview-screener/.venv/lib/python3.12/site-packages')
from tvscreener import StockField
print("Fields with 'Symbol' (exact):")
for attr in dir(StockField):
    if attr == 'Symbol':
        print(attr, getattr(StockField, attr))
print("\nFields containing 'Symbol' (case sensitive):")
for attr in dir(StockField):
    if 'Symbol' in attr:
        print(attr, getattr(StockField, attr))
