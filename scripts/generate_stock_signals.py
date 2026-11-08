#!/usr/bin/env python3
"""
Script personalizado para generar señales de stock diario basado en la watchlist del usuario.
Obtiene indicadores técnicos (RSI14, MACD, SMA20/50, ATR, Volumen) y precios para los tickers.
Fallback esperado si TradingView falla: usar MCP de tradingview-mcp.onrender.com para recuperar datos de mercado y extras.
"""

import os
import sys
import re
import json
import subprocess
from datetime import datetime, timedelta
from collections import defaultdict

# Añadir el skill de tradingview-screener al path
sys.path.insert(0, '/home/ubuntu/.openclaw/workspace/skills/tradingview-screener')

from tvscreener import StockScreener
from tvscreener.field.stock import StockField

def read_watchlist():
    """Lee la watchlist desde el archivo markdown"""
    watchlist_path = '/home/ubuntu/.openclaw/workspace/memory/watchlist-stocks.md'
    
    with open(watchlist_path, 'r') as f:
        content = f.read()
    
    # Extraer tickers del formato original TradingView, preservando orden y sin duplicados
    tickers = re.findall(r'([A-Z_]+):([A-Z0-9.]+)', content)
    seen = set()
    ordered = []
    for exchange, symbol in tickers:
        key = f"{exchange}:{symbol}"
        if key not in seen:
            seen.add(key)
            ordered.append(key)
    return ordered

def get_stock_data(symbols):
    """Obtiene datos de los símbolos usando TradingView Screener; si falla, usa MCP como respaldo."""
    try:
        screener = StockScreener()
        screener.select(
            StockField.NAME,
            StockField.PRICE,
            StockField.CHANGE_PERCENT,
            StockField.RELATIVE_STRENGTH_INDEX_14,
            StockField.SIMPLE_MOVING_AVERAGE_50,
            StockField.SIMPLE_MOVING_AVERAGE_20,
            StockField.MACD_LEVEL_12_26,
            StockField.MACD_SIGNAL_12_26,
            StockField.AVERAGE_TRUE_RANGE_14,
            StockField.AVERAGE_VOLUME_10_DAY,
            StockField.VOLUME,
            StockField.MARKET_CAPITALIZATION,
            StockField.SECTOR,
            StockField.SIMPLE_MOVING_AVERAGE_200,
            StockField.AVERAGE_VOLUME_30_DAY
        )

        result = screener.get()

        if result is None or len(result) == 0:
            raise RuntimeError("TradingView screener returned empty result")

        # Match más tolerante, porque TradingView no siempre devuelve el mismo naming
        symbol_map = defaultdict(list)
        for _, row in result.iterrows():
            name = str(row.get('Name', '')).strip().upper()
            symbol_map[name].append(row)

        stocks = []
        missing = []
        for symbol in symbols:
            exchange, ticker = symbol.split(':', 1)
            candidates = [ticker.upper(), f"{exchange}:{ticker}".upper()]
            row = None
            for candidate in candidates:
                if candidate in symbol_map and symbol_map[candidate]:
                    row = symbol_map[candidate][0]
                    break
            if row is None:
                # fallback por sufijo, útil para algunos símbolos/índices
                for name, rows in symbol_map.items():
                    if name.endswith(f":{ticker.upper()}") or name == ticker.upper():
                        row = rows[0]
                        break
            if row is None:
                missing.append(symbol)
                continue
            stocks.append({
                'watchlist_symbol': symbol,
                'symbol': row.get('Name', ticker),
                'price': row.get('Price', 0),
                'change_percent': row.get('Change %', 0),
                'rsi': row.get('Relative Strength Index (14)', 0),
                'sma50': row.get('Simple Moving Average (50)', 0),
                'sma20': row.get('Simple Moving Average (20)', 0),
                'sma200': row.get('Simple Moving Average (200)', 0),
                'macd': row.get('MACD Level (12, 26)', 0),
                'macd_signal': row.get('MACD Signal (12, 26)', 0),
                'atr': row.get('Average True Range (14)', 0),
                'volume': row.get('Volume', 0),
                'avg_volume': row.get('Average Volume (10 day)', row.get('Average Volume (30 day)', 0)),
                'market_cap': row.get('Market Capitalization', 0),
                'sector': row.get('Sector', '')
            })

        return stocks, missing

    except Exception as e:
        print(f"Error obteniendo datos de TradingView: {e}")
        print("Intentando fallback MCP de TradingView...")
        return get_stock_data_via_mcp(symbols)


def _mcporter_call(tool, **kwargs):
    cmd = [
        'mcporter', 'call',
        '--http-url', 'https://tradingview-mcp.onrender.com/mcp',
        tool,
        '--output', 'json',
        '--timeout', '60000'
    ]
    for k, v in kwargs.items():
        cmd.append(f'{k}={v}')
    out = subprocess.check_output(cmd, text=True, stderr=subprocess.STDOUT)
    return json.loads(out)


def _pick(d, *keys, default=None):
    for k in keys:
        if isinstance(d, dict) and k in d and d[k] is not None:
            return d[k]
    return default


def get_stock_data_via_mcp(symbols):
    """Fallback usando el MCP de TradingView si el screener local falla."""
    stocks = []
    missing = []
    for symbol in symbols:
        exchange, ticker = symbol.split(':', 1)
        try:
            data = _mcporter_call('combined_analysis', symbol=ticker, exchange=exchange, timeframe='1D')
            result = _pick(data, 'result', default=data)
            if isinstance(result, dict):
                price = _pick(result, 'price', 'current_price', 'last_price', default=0)
                change = _pick(result, 'change_percent', 'change', default=0)
                rsi = _pick(result, 'rsi', 'rsi14', default=0)
                macd = _pick(result, 'macd', default=0)
                macd_signal = _pick(result, 'macd_signal', default=0)
                sma20 = _pick(result, 'sma20', 'sma_20', default=0)
                sma50 = _pick(result, 'sma50', 'sma_50', default=0)
                sma200 = _pick(result, 'sma200', 'sma_200', default=0)
                atr = _pick(result, 'atr', default=0)
                volume = _pick(result, 'volume', default=0)
                avg_volume = _pick(result, 'avg_volume', 'average_volume', default=0)
                market_cap = _pick(result, 'market_cap', 'market_capitalization', default=0)
                sector = _pick(result, 'sector', default='')
            else:
                price = change = rsi = macd = macd_signal = sma20 = sma50 = sma200 = atr = volume = avg_volume = market_cap = 0
                sector = ''
            stocks.append({
                'watchlist_symbol': symbol,
                'symbol': ticker,
                'price': float(price or 0),
                'change_percent': float(change or 0),
                'rsi': float(rsi or 0),
                'sma50': float(sma50 or 0),
                'sma20': float(sma20 or 0),
                'sma200': float(sma200 or 0),
                'macd': float(macd or 0),
                'macd_signal': float(macd_signal or 0),
                'atr': float(atr or 0),
                'volume': float(volume or 0),
                'avg_volume': float(avg_volume or 0),
                'market_cap': market_cap,
                'sector': sector,
            })
        except Exception:
            try:
                px = _mcporter_call('yahoo_price', symbol=ticker)
                px_res = _pick(px, 'result', default=px)
                if isinstance(px_res, dict):
                    price = _pick(px_res, 'price', 'regularMarketPrice', default=0)
                    change = _pick(px_res, 'change_percent', 'changePercent', default=0)
                else:
                    price = change = 0
            except Exception:
                price = change = 0
            try:
                _mcporter_call('financial_news', symbol=ticker, category='stocks', limit=3)
            except Exception:
                pass
            try:
                _mcporter_call('market_sentiment', symbol=ticker, category='all', limit=20)
            except Exception:
                pass
            missing.append(symbol)
    return stocks, missing

def format_report(stocks_data, missing_symbols):
    """Formatea el reporte con nuevos indicadores"""
    if not stocks_data and not missing_symbols:
        return "No se pudieron obtener datos de las acciones en la watchlist."
    
    report = f"---\n📊 *ANÁLISIS AMPLIADO — {datetime.now().strftime('%A %d/%m/%Y')}*\n\n"
    
    extreme_oversold = [s for s in stocks_data if s['rsi'] < 25]
    oversold = [s for s in stocks_data if 25 <= s['rsi'] < 35]
    neutral = [s for s in stocks_data if 35 <= s['rsi'] <= 65]
    overbought = [s for s in stocks_data if s['rsi'] > 70]
    
    def format_stock(stock):
        macd_bull = stock['macd'] > stock['macd_signal']
        trend_bull = stock['price'] > stock['sma20']
        vol_high = stock['volume'] > stock['avg_volume']
        atr = stock['atr']
        
        res = f"{stock['symbol']} ${stock['price']:.2f} ({stock['change_percent']:+.1f}%) | RSI: {stock['rsi']:.1f}\n"
        res += f"- *Tendencia (SMA20):* {'Alcista' if trend_bull else 'Bajista'} | *MACD:* {'Bullish' if macd_bull else 'Bearish'}\n"
        res += f"- *Volumen:* {'Alto' if vol_high else 'Normal'} | *ATR:* ${atr:.2f}\n"
        if stock['rsi'] > 70:
            rec = "⚠️ VENDER / TOMAR GANANCIAS (Sobrecomprado)"
        elif stock['rsi'] < 30:
            rec = "🚀 COMPRA FUERTE (Oversold + Reversión)" if trend_bull and macd_bull else "👀 ESPERAR SUELO (Oversold pero sin confirmación)"
        elif trend_bull and macd_bull:
            rec = "✅ MANTENER / ACUMULAR (Tendencia Alcista)"
        elif not trend_bull and not macd_bull:
            rec = "📉 REDUCIR POSICIÓN (Tendencia Bajista)"
        else:
            rec = "⏳ MONITORIZAR (Sin señal clara)"
        
        stop_loss = stock['price'] - (1.5 * atr)
        res += f"- *Stop Loss sugerido:* ${stop_loss:.2f}\n"
        res += f"- *Sugerencia:* {rec}\n"
        return res

    report += "*🔴 SOBRESVENDIDOS EXTREMOS*\n"
    report += "\n".join([format_stock(s) for s in extreme_oversold]) if extreme_oversold else "No hay.\n"
    report += "\n*⚠️ SOBRESVENDIDOS*\n"
    report += "\n".join([format_stock(s) for s in oversold]) if oversold else "No hay.\n"
    report += "\n*🟡 NEUTROS*\n"
    report += "\n".join([format_stock(s) for s in neutral]) if neutral else "No hay.\n"
    report += "\n*🔴 SOBRECOMPRADOS*\n"
    report += "\n".join([format_stock(s) for s in overbought]) if overbought else "No hay.\n"
    if missing_symbols:
        report += "\n*⚪ NO DISPONIBLES HOY EN TRADINGVIEW*\n"
        report += "\n".join([f"- {s}" for s in missing_symbols])
    report += "\n---"
    return report

def main():
    watchlist = read_watchlist()
    stocks_data, missing_symbols = get_stock_data(watchlist)
    print(format_report(stocks_data, missing_symbols))

if __name__ == "__main__":
    main()