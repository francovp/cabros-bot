from tvscreener import StockScreener, StockField

def get_data():
    # Only ticker symbols, TradingView might need "EXCHANGE:TICKER" format if not specified, 
    # but the screener seems to handle the exchange if we just pass tickers. 
    # Wait, the prompt watchlist uses "NASDAQ:QCOM". Let's try passing that.
    tickers = ['QCOM', 'SMCI', 'AMD', 'INTC', 'TSLA', 'AAPL', 'ORCL', 'META', 'MU', 'WDC', 'GOOG', 'AMZN', 'TSM', 'MSFT', 'AVGO', 'NVDA', 'SQM', 'BCH', 'NFLX', 'TTWO']
    
    screener = StockScreener()
    # screener.symbols = {"tickers": [f"NASDAQ:{t}" for t in tickers]} # Just a guess on format
    # Actually, looking at the symbols structure in base.py: {"query": {"types": []}, "tickers": []}
    # Maybe I can just pass the tickers.
    
    # Try searching by name as a fallback?
    # screener.where(StockField.NAME.isin(tickers)) # This should work if StockScreener has 'where'
    
    # Let's try just 'where' and make sure I use 'where' instead of 'filter'
    screener.where(StockField.NAME.isin(tickers))
    
    screener.select(
        StockField.NAME,
        StockField.PRICE,
        StockField.CHANGE_PERCENT,
        StockField.RELATIVE_STRENGTH_INDEX_14,
        StockField.SIMPLE_MOVING_AVERAGE_20,
        StockField.MACD_LEVEL_12_26,
        StockField.VOLUME
    )
    return screener.get()

print(get_data())
