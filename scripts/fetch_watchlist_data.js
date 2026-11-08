const fs = require('fs');

const watchlist = {
  stocks: [
    'QCOM', 'SMCI', 'AMD', 'INTC', 'TSLA', 'AAPL', 'ORCL', 'META', 'MU', 'WDC', 
    'GOOG', 'AMZN', 'TSM', 'MSFT', 'AVGO', 'NVDA', 'SQM', 'BCH', 'NFLX', 'TTWO'
  ],
  indexes: [
    '^NDX', '^GSPC', 'GLD', 'SLV' // SPX is ^GSPC in Yahoo
  ],
  cryptos: [
    'BNBUSDT', 'ETHUSDT', 'BTCUSDT'
  ],
  forex: [
    'USDCLP=X'
  ]
};

function ema(values, period){
  const k = 2/(period+1);
  let prev = values.slice(0, period).reduce((a,b)=>a+b,0)/period;
  const out = [prev];
  for (let i=period;i<values.length;i++){
    prev = values[i]*k + prev*(1-k);
    out.push(prev);
  }
  return out;
}
function rsi(closes, period=14){
  const gains=[]; const losses=[];
  for(let i=1;i<closes.length;i++){
    const ch=closes[i]-closes[i-1];
    gains.push(Math.max(0,ch)); losses.push(Math.max(0,-ch));
  }
  let avgGain = gains.slice(0, period).reduce((a,b)=>a+b,0)/period;
  let avgLoss = losses.slice(0, period).reduce((a,b)=>a+b,0)/period;
  let value = avgLoss === 0 ? 100 : 100 - (100/(1 + avgGain/avgLoss));
  for(let i=period;i<gains.length;i++){
    avgGain = (avgGain*(period-1)+gains[i])/period;
    avgLoss = (avgLoss*(period-1)+losses[i])/period;
    value = avgLoss === 0 ? 100 : 100 - (100/(1 + avgGain/avgLoss));
  }
  return value;
}
function sma(values, period){
  const arr = values.slice(-period);
  return arr.reduce((a,b)=>a+b,0)/period;
}
function macd(closes){
  const ema12 = [];
  const ema26 = [];
  const k12 = 2/(12+1), k26 = 2/(26+1);
  let p12 = closes.slice(0,12).reduce((a,b)=>a+b,0)/12;
  let p26 = closes.slice(0,26).reduce((a,b)=>a+b,0)/26;
  for (let i=0;i<closes.length;i++){
    if (i<11) { ema12.push(null); } else if (i===11) { ema12.push(p12); } else { p12 = closes[i]*k12 + p12*(1-k12); ema12.push(p12); }
    if (i<25) { ema26.push(null); } else if (i===25) { ema26.push(p26); } else { p26 = closes[i]*k26 + p26*(1-k26); ema26.push(p26); }
  }
  const macdLine = closes.map((_,i)=> (ema12[i] != null && ema26[i] != null) ? ema12[i]-ema26[i] : null).filter(v=>v!=null);
  const signal = ema(macdLine, 9);
  const macdVal = macdLine[macdLine.length-1];
  const signalVal = signal[signal.length-1];
  return {macdVal, signalVal, bullish: macdVal > signalVal};
}
function atr(candles, period=14){
  const trs=[];
  for(let i=0;i<candles.length;i++){
    const {high, low} = candles[i];
    if (i===0) trs.push(high-low);
    else {
      const prevClose = candles[i-1].close;
      trs.push(Math.max(high-low, Math.abs(high-prevClose), Math.abs(low-prevClose)));
    }
  }
  const arr = trs.slice(-period);
  return arr.reduce((a,b)=>a+b,0)/period;
}
async function yahoo(symbol){
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d&includePrePost=false&events=div,splits`;
  const res = await fetch(url, {headers:{'user-agent':'Mozilla/5.0'}});
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No Yahoo data for ${symbol}`);
  const q = result.indicators.quote[0];
  const closes = result.indicators.adjclose?.[0]?.adjclose || q.close;
  const candles = closes.map((c,i)=>({open:q.open[i],high:q.high[i],low:q.low[i],close:c,volume:q.volume[i]})).filter(x=>Number.isFinite(x.close)&&Number.isFinite(x.high)&&Number.isFinite(x.low));
  return candles;
}
async function binance(symbol){
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=120`;
  const res = await fetch(url);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`No Binance data for ${symbol}`);
  return data.map(k=>({open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5]}));
}

(async()=>{
  const out = {};
  
  for (const s of [...watchlist.stocks, ...watchlist.indexes, ...watchlist.forex]){
    try {
      const candles = await yahoo(s);
      const closes = candles.map(c=>c.close).filter(v=>Number.isFinite(v));
      const last = candles[candles.length-1];
      const prev = candles[candles.length-2];
      const r = rsi(closes,14);
      const sma20 = sma(closes,20);
      const macdRes = macd(closes);
      const atr14 = atr(candles,14);
      const avg10 = candles.slice(-11,-1).reduce((a,b)=>a+b.volume,0)/10;
      out[s] = {
        price: last.close,
        changePct: ((last.close-prev.close)/prev.close*100),
        rsi: r,
        sma20,
        macdBullish: macdRes.bullish,
        volume: last.volume,
        avg10,
        atr14,
        trend: last.close >= sma20 ? 'Alcista' : 'Bajista',
        volumeLabel: last.volume >= avg10*1.2 ? 'Alto' : 'Normal',
      };
    } catch(e) { console.error(`Error ${s}: ${e.message}`); }
  }
  
  for (const s of watchlist.cryptos){
    try {
      const candles = await binance(s);
      const closes = candles.map(c=>c.close);
      const last = candles[candles.length-1];
      const prev = candles[candles.length-2];
      const r = rsi(closes,14);
      const sma20 = sma(closes,20);
      const macdRes = macd(closes);
      const atr14 = atr(candles,14);
      const avg10 = candles.slice(-11,-1).reduce((a,b)=>a+b.volume,0)/10;
      out[s] = {
        price: last.close,
        changePct: ((last.close-prev.close)/prev.close*100),
        rsi: r,
        sma20,
        macdBullish: macdRes.bullish,
        volume: last.volume,
        avg10,
        atr14,
        trend: last.close >= sma20 ? 'Alcista' : 'Bajista',
        volumeLabel: last.volume >= avg10*1.2 ? 'Alto' : 'Normal',
      };
    } catch(e) { console.error(`Error ${s}: ${e.message}`); }
  }
  
  process.stdout.write(JSON.stringify(out, null, 2));
})();
