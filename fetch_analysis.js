const MCP_URL = 'https://tradingview-mcp-yp6b.onrender.com/mcp';

async function initializeMCP() {
  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream, application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'init-1',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cabros-analysis', version: '1.0' },
      },
    }),
  });

  const sessionId = response.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('No session ID returned');

  // Send initialized notification
  await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream, application/json',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }),
  });

  return sessionId;
}

async function callCoinAnalysis(sessionId, symbol, exchange, timeframe = '1h') {
  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream, application/json',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `tool-${Date.now()}`,
      method: 'tools/call',
      params: {
        name: 'coin_analysis',
        arguments: { symbol, exchange, timeframe },
      },
    }),
  });

  const text = await response.text();
  // Parse SSE response
  const dataLines = text.split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('data:'))
    .map(line => line.substring(5).trim())
    .filter(Boolean);

  if (dataLines.length === 0) return null;

  const parsed = JSON.parse(dataLines[0]);
  if (parsed.error) throw new Error(parsed.error.message);

  const contentText = parsed.result?.content?.[0]?.text;
  if (!contentText) return null;

  return JSON.parse(contentText);
}

const watchlist = [
  // STOCKS TECH
  { symbol: 'QCOM', exchange: 'NASDAQ' },
  { symbol: 'SMCI', exchange: 'NASDAQ' },
  { symbol: 'AMD', exchange: 'NASDAQ' },
  { symbol: 'INTC', exchange: 'NASDAQ' },
  { symbol: 'TSLA', exchange: 'NASDAQ' },
  { symbol: 'AAPL', exchange: 'NASDAQ' },
  { symbol: 'ORCL', exchange: 'NYSE' },
  { symbol: 'META', exchange: 'NASDAQ' },
  { symbol: 'MU', exchange: 'NASDAQ' },
  { symbol: 'WDC', exchange: 'NASDAQ' },
  { symbol: 'GOOG', exchange: 'NASDAQ' },
  { symbol: 'AMZN', exchange: 'NASDAQ' },
  { symbol: 'TSM', exchange: 'NYSE' },
  { symbol: 'MSFT', exchange: 'NASDAQ' },
  { symbol: 'AVGO', exchange: 'NASDAQ' },
  { symbol: 'NVDA', exchange: 'NASDAQ' },
  // CHILE
  { symbol: 'SQM', exchange: 'NYSE' },
  { symbol: 'BCH', exchange: 'NYSE' },
  // OTROS
  { symbol: 'NFLX', exchange: 'NASDAQ' },
  { symbol: 'TTWO', exchange: 'NASDAQ' },
  // INDEXES
  { symbol: 'NDX', exchange: 'NASDAQ' },
  { symbol: 'SPX', exchange: 'SP' },
  { symbol: 'GLD', exchange: 'AMEX' },
  { symbol: 'SLV', exchange: 'AMEX' },
  // CRYPTO
  { symbol: 'BNBUSDT', exchange: 'BINANCE' },
  { symbol: 'ETHUSDT', exchange: 'BINANCE' },
  { symbol: 'BTCUSDT', exchange: 'BINANCE' },
  // FOREX
  { symbol: 'USDCLP', exchange: 'FX_IDC' },
];

async function main() {
  console.log('Initializing MCP...');
  const sessionId = await initializeMCP();
  console.log(`Session ID: ${sessionId}`);

  const results = [];

  for (const { symbol, exchange } of watchlist) {
    try {
      console.log(`Fetching ${exchange}:${symbol}...`);
      const data = await callCoinAnalysis(sessionId, symbol, exchange);
      if (data) {
        results.push({ symbol: `${exchange}:${symbol}`, data });
      } else {
        results.push({ symbol: `${exchange}:${symbol}`, error: 'No data returned' });
      }
    } catch (error) {
      console.error(`Error for ${exchange}:${symbol}:`, error.message);
      results.push({ symbol: `${exchange}:${symbol}`, error: error.message });
    }
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n=== RESULTS ===');
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);