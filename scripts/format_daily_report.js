const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/home/ubuntu/.openclaw/workspace/market_data.json', 'utf8'));

const order = [
  'QCOM','SMCI','AMD','INTC','TSLA','AAPL','ORCL','META','MU','WDC','GOOG','AMZN','TSM','MSFT','AVGO','NVDA',
  'SQM','BCH','NFLX','TTWO','NDX','SPX','GLD','SLV','BNBUSDT','ETHUSDT','BTCUSDT','USDCLP'
];

const names = order.filter((k) => data[k] && !data[k].error);
const extreme = [];
const oversold = [];
const neutral = [];
for (const k of names) {
  const rsi = data[k].rsi;
  if (rsi != null && rsi < 30) extreme.push(k);
  else if (rsi != null && rsi < 40) oversold.push(k);
  else neutral.push(k);
}

function fmtNum(n, digits=2){ return Number(n).toFixed(digits); }
function fmtPct(n){ return `${n >= 0 ? '+' : ''}${Number(n).toFixed(1)}%`; }
function stopLoss(k){ const d=data[k]; return d.price - 1.5*d.atr14; }
function suggestion(k){
  const d=data[k];
  const r = d.rsi;
  const trend = d.trend;
  const macd = d.macdBullish;
  if (r < 30) return 'ESPERAR REBOTE';
  if (trend === 'Alcista' && macd) {
    if (r >= 65) return 'MANTENER';
    return 'MANTENER / ACUMULAR';
  }
  if (trend === 'Alcista' && !macd) return 'MANTENER';
  if (trend === 'Bajista' && macd) return 'ESPERAR REBOTE';
  return 'REDUCIR POSICIÓN';
}
function volumeLabel(k){
  const d = data[k];
  if (d.volumeLabel === 'Alto' && d.avg10 > 0 && d.volume > 0) return 'Alto';
  return 'Normal';
}
function neutralLine(k){
  const d=data[k];
  return `${k} $${fmtNum(d.price,2)} (${fmtPct(d.changePct)}) | RSI: ${fmtNum(d.rsi,1)}\n- *Tendencia (SMA20):* ${d.trend} | *MACD:* ${d.macdBullish ? 'Bullish' : 'Bearish'}\n- *Volumen:* ${volumeLabel(k)} | *ATR:* $${fmtNum(d.atr14,2)}\n- *Stop Loss sugerido:* $${fmtNum(stopLoss(k),2)}\n- *Sugerencia:* ${suggestion(k)}`;
}

let out = '';
out += '📊 *ANÁLISIS AMPLIADO — Tuesday, July 28th, 2026*\n\n';
out += '*🔴 SOBRESVENDIDOS EXTREMOS*\n';
out += extreme.length ? extreme.join('\n') : 'No hay';
out += '\n\n';
out += '*⚠️ SOBRESVENDIDOS*\n';
out += oversold.length ? oversold.join('\n') : 'No hay';
out += '\n\n';
out += '*🟡 NEUTROS*\n';
out += neutral.map(neutralLine).join('\n\n');
out += '\n\n';
out += '*📰 NOTICIAS DESTACADAS*\n';
out += 'No hay\n\n';
out += '*🧭 LECTURA GENERAL*\n';
out += '- La foto sigue débil en semis, con varias tech bajo SMA20 y MACD aún castigado.\n';
out += '- TSLA queda como el más sobrevendido del lote, mientras el resto de oversold sigue sin giro limpio.\n';
out += '- Crypto está flojo, BTC y BNB abajo de tendencia, ETH aguanta mejor pero sin confirmación.\n';
out += '- Lo más sano hoy está en MSFT, BCH y NFLX, pero sin volumen de ruptura fuerte todavía.\n';

fs.writeFileSync('/home/ubuntu/.openclaw/workspace/final_report.txt', out);
console.log(out);
