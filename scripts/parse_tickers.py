import re

tickers = []
with open('memory/watchlist-stocks.md', 'r') as f:
    for line in f:
        match = re.search(r'(NASDAQ|NYSE|SP|AMEX|BINANCE|FX_IDC):(\w+)', line)
        if match:
            tickers.append(match.group(2))

print(tickers)
