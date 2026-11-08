const fs = require('fs');

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [prev];
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsi(closes, period = 14) {
  if (closes.length <= period) return null;
  const gains = [];
  const losses = [];
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    gains.push(Math.max(0, ch));
    losses.push(Math.max(0, -ch));
  }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let value = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    value = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return value;
}

function sma(values, period) {
  if (values.length < period) return null;
  const arr = values.slice(-period);
  return arr.reduce((a, b) => a + b, 0) / period;
}

function macd(closes) {
  if (closes.length < 35) return null;
  const ema12 = [];
  const ema26 = [];
  const k12 = 2 / (12 + 1);
  const k26 = 2 / (26 + 1);
  let p12 = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
  let p26 = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
  for (let i = 0; i < closes.length; i++) {
    if (i < 11) {
      ema12.push(null);
    } else if (i === 11) {
      ema12.push(p12);
    } else {
      p12 = closes[i] * k12 + p12 * (1 - k12);
      ema12.push(p12);
    }
    if (i < 25) {
      ema26.push(null);
    } else if (i === 25) {
      ema26.push(p26);
    } else {
      p26 = closes[i] * k26 + p26 * (1 - k26);
      ema26.push(p26);
    }
  }
  const macdLine = closes
    .map((_, i) => (ema12[i] != null && ema26[i] != null ? ema12[i] - ema26[i] : null))
    .filter((v) => v != null);
  const signal = ema(macdLine, 9);
  return {
    macdVal: macdLine[macdLine.length - 1],
    signalVal: signal[signal.length - 1],
    bullish: macdLine[macdLine.length - 1] > signal[signal.length - 1],
  };
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 0; i < candles.length; i++) {
    const { high, low } = candles[i];
    if (i === 0) trs.push(high - low);
    else {
      const prevClose = candles[i - 1].close;
      trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
  }
  const arr = trs.slice(-period);
  return arr.reduce((a, b) => a + b, 0) / period;
}

async function yahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=9mo&interval=1d&includePrePost=false&events=div,splits`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No Yahoo data for ${symbol}: ${JSON.stringify(data?.chart?.error || data)}`);
  const q = result.indicators.quote[0];
  const closes = result.indicators.adjclose?.[0]?.adjclose || q.close;
  const candles = closes
    .map((c, i) => ({ open: q.open[i], high: q.high[i], low: q.low[i], close: c, volume: q.volume[i] }))
    .filter((x) => Number.isFinite(x.close) && Number.isFinite(x.high) && Number.isFinite(x.low));
  return candles;
}

async function binance(symbol) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=120`;
  const res = await fetch(url);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`No Binance data for ${symbol}: ${JSON.stringify(data)}`);
  return data.map((k) => ({ open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
}

const symbols = [
  { key: 'QCOM', source: 'yahoo', symbol: 'QCOM' },
  { key: 'SMCI', source: 'yahoo', symbol: 'SMCI' },
  { key: 'AMD', source: 'yahoo', symbol: 'AMD' },
  { key: 'INTC', source: 'yahoo', symbol: 'INTC' },
  { key: 'TSLA', source: 'yahoo', symbol: 'TSLA' },
  { key: 'AAPL', source: 'yahoo', symbol: 'AAPL' },
  { key: 'ORCL', source: 'yahoo', symbol: 'ORCL' },
  { key: 'META', source: 'yahoo', symbol: 'META' },
  { key: 'MU', source: 'yahoo', symbol: 'MU' },
  { key: 'WDC', source: 'yahoo', symbol: 'WDC' },
  { key: 'GOOG', source: 'yahoo', symbol: 'GOOG' },
  { key: 'AMZN', source: 'yahoo', symbol: 'AMZN' },
  { key: 'TSM', source: 'yahoo', symbol: 'TSM' },
  { key: 'MSFT', source: 'yahoo', symbol: 'MSFT' },
  { key: 'AVGO', source: 'yahoo', symbol: 'AVGO' },
  { key: 'NVDA', source: 'yahoo', symbol: 'NVDA' },
  { key: 'SQM', source: 'yahoo', symbol: 'SQM' },
  { key: 'BCH', source: 'yahoo', symbol: 'BCH' },
  { key: 'NFLX', source: 'yahoo', symbol: 'NFLX' },
  { key: 'TTWO', source: 'yahoo', symbol: 'TTWO' },
  { key: 'NDX', source: 'yahoo', symbol: '^NDX' },
  { key: 'SPX', source: 'yahoo', symbol: '^GSPC' },
  { key: 'GLD', source: 'yahoo', symbol: 'GLD' },
  { key: 'SLV', source: 'yahoo', symbol: 'SLV' },
  { key: 'USDCLP', source: 'yahoo', symbol: 'USDCLP=X' },
  { key: 'BNBUSDT', source: 'binance', symbol: 'BNBUSDT' },
  { key: 'ETHUSDT', source: 'binance', symbol: 'ETHUSDT' },
  { key: 'BTCUSDT', source: 'binance', symbol: 'BTCUSDT' },
];

(async () => {
  const out = {};
  for (const item of symbols) {
    try {
      const candles = item.source === 'yahoo' ? await yahooChart(item.symbol) : await binance(item.symbol);
      const closes = candles.map((c) => c.close).filter(Number.isFinite);
      const last = candles[candles.length - 1];
      const prev = candles[candles.length - 2];
      const sma20 = sma(closes, 20);
      const r = rsi(closes, 14);
      const m = macd(closes);
      const a = atr(candles, 14);
      const avg10 = candles.slice(-11, -1).reduce((acc, c) => acc + (Number.isFinite(c.volume) ? c.volume : 0), 0) / 10;
      const volumeLabel = Number.isFinite(last.volume) && Number.isFinite(avg10) && last.volume >= avg10 * 1.2 ? 'Alto' : 'Normal';
      const price = last.close;
      const changePct = item.source === 'binance'
        ? +(await (await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${item.symbol}`)).json()).priceChangePercent
        : +(((last.close - prev.close) / prev.close) * 100);
      out[item.key] = {
        price,
        changePct,
        rsi: r,
        sma20,
        macdBullish: m?.bullish,
        macdLine: m?.macdVal,
        signalLine: m?.signalVal,
        volume: last.volume,
        avg10,
        atr14: a,
        trend: last.close >= sma20 ? 'Alcista' : 'Bajista',
        volumeLabel,
      };
    } catch (e) {
      out[item.key] = { error: e.message };
    }
  }
  fs.writeFileSync('/home/ubuntu/.openclaw/workspace/market_data.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})();
