#!/usr/bin/env python3
"""
Fetch daily index values for IXG and MOVE.
Uses TradingView screener for IXG and Yahoo Finance API for MOVE.
"""
import sys
import requests
from datetime import datetime

sys.path.insert(0, '/home/ubuntu/.openclaw/workspace/skills/tradingview-screener')
from tvscreener import StockScreener
from tvscreener.field.stock import StockField

def fetch_ixg():
    """Fetch IXG (iShares Global Financials ETF) from TradingView."""
    try:
        sc = StockScreener()
        sc.select(StockField.NAME, StockField.PRICE, StockField.CHANGE_PERCENT)
        sc.symbols = {'query': {'types': []}, 'tickers': ['AMEX:IXG']}
        result = sc.get()
        
        if result is not None and not result.empty:
            row = result.iloc[0]
            return {
                'symbol': 'IXG',
                'name': row.get('Name', 'IXG'),
                'price': row.get('Price', 0),
                'change_percent': row.get('Change %', 0),
                'source': 'TradingView (AMEX)'
            }
    except Exception as e:
        print(f"Error fetching IXG: {e}")
    return None

def fetch_move():
    """Fetch MOVE Index from Yahoo Finance API."""
    url = "https://query1.finance.yahoo.com/v8/finance/chart/^MOVE"
    params = {"interval": "1d", "range": "1d"}
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    try:
        response = requests.get(url, params=params, headers=headers, timeout=10)
        response.raise_for_status()
        data = response.json()
        meta = data['chart']['result'][0]['meta']
        
        price = meta.get('regularMarketPrice')
        prev_close = meta.get('chartPreviousClose')
        
        if price and prev_close:
            change_percent = ((price - prev_close) / prev_close) * 100
            return {
                'price': price,
                'change_percent': change_percent,
                'source': 'Yahoo Finance (^MOVE)'
            }
    except Exception as e:
        print(f"Error fetching MOVE: {e}")
    return None

def main():
    print("📊 *Daily Index Report*")
    print("")
    
    # FETCH IXG
    ixg = fetch_ixg()
    if ixg:
        change_str = f"{ixg['change_percent']:+.2f}%"
        print(f"*IXG* (iShares Global Financials ETF): ${ixg['price']:.2f} ({change_str})")
        print(f"  _Source: {ixg['source']}_")
    else:
        print("*IXG*: No disponible")
    
    print("")
    
    # FETCH MOVE
    move = fetch_move()
    if move:
        change_str = f"{move['change_percent']:+.2f}%"
        print(f"*MOVE Index* (Merrill Lynch Option Volatility Estimate): {move['price']:.2f} ({change_str})")
        print(f"  _Source: {move['source']}_")
    else:
        print("*MOVE Index*: No disponible")
    
    print("")
    print(f"_Reporte: {datetime.now().strftime('%A, %d de %B de %Y')}_")

if __name__ == "__main__":
    main()
