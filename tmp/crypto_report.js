const https = require('https');

function rsi(closes, period = 14) {
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    gains.push(Math.max(0, ch));
    losses.push(Math.max(0, -ch));
  }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let value = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    value = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return value;
}
function sma(values, period) {
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}
function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [prev];
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
function macd(closes) {
  const ema12 = [];
  const ema26 = [];
  const k12 = 2 / 13, k26 = 2 / 27;
  let p12 = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
  let p26 = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
  for (let i = 0; i < closes.length; i++) {
    if (i < 11) ema12.push(null);
    else if (i === 11) ema12.push(p12);
    else { p12 = closes[i] * k12 + p12 * (1 - k12); ema12.push(p12); }
    if (i < 25) ema26.push(null);
    else if (i === 25) ema26.push(p26);
    else { p26 = closes[i] * k26 + p26 * (1 - k26); ema26.push(p26); }
  }
  const macdLine = closes.map((_, i) => (ema12[i] != null && ema26[i] != null) ? ema12[i] - ema26[i] : null).filter(v => v != null);
  const signal = ema(macdLine, 9);
  return { macdVal: macdLine[macdLine.length - 1], signalVal: signal[signal.length - 1], bullish: macdLine[macdLine.length - 1] > signal[signal.length - 1] };
}
function atr(candles, period = 14) {
  const trs = [];
  for (let i = 0; i < candles.length; i++) {
    const { high, low } = candles[i];
    if (i === 0) trs.push(high - low);
    else {
      const prevClose = candles[i - 1].close;
      trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'Mozilla/5.0' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`${url} :: ${d.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}
(async () => {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
  const out = {};
  for (const s of symbols) {
    const data = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${s}&interval=1d&limit=120`);
    const candles = data.map(k => ({ open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
    const closes = candles.map(c => c.close);
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const m = macd(closes);
    const ticker = await fetchJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${s}`);
    const avg10 = candles.slice(-11, -1).reduce((a, b) => a + b.volume, 0) / 10;
    out[s] = {
      price: +ticker.lastPrice,
      changePct: +ticker.priceChangePercent,
      rsi: rsi(closes, 14),
      sma20: sma(closes, 20),
      macdBullish: m.bullish,
      volume: last.volume,
      avg10,
      atr14: atr(candles, 14),
      trend: last.close >= sma(closes, 20) ? 'Alcista' : 'Bajista',
      volumeLabel: last.volume >= avg10 * 1.2 ? 'Alto' : 'Normal',
    };
  }
  console.log(JSON.stringify(out, null, 2));
})().catch(err => { console.error(err); process.exit(1); });
