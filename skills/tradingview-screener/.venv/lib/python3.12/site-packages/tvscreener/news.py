import json
import re
from datetime import datetime, timezone

import pandas as pd
import requests

NEWS_URL = "https://news-mediator.tradingview.com/public/news-flow/v2/news"
ARTICLE_BASE_URL = "https://www.tradingview.com"
REQUEST_TIMEOUT = 30

REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Origin': 'https://www.tradingview.com',
    'Referer': 'https://www.tradingview.com/',
}


def get_news(symbol=None, lang="en"):
    """
    Get news headlines from TradingView.

    :param symbol: TradingView symbol (e.g. "NASDAQ:AAPL", "BINANCE:BTCUSDT"). If None, returns global news.
    :param lang: Language code (default "en")
    :return: DataFrame with columns: title, published, provider, related_symbols, story_path, urgency
    """
    params = {
        "filter": [f"lang:{lang}"],
        "client": "overview",
        "streaming": "false",
        "user_prostatus": "non_pro",
    }
    if symbol:
        params["filter"].append(f"symbol:{symbol}")

    response = requests.get(
        NEWS_URL,
        params=params,
        headers=REQUEST_HEADERS,
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    data = response.json()

    rows = []
    for item in data.get("items", []):
        related = [s["symbol"] for s in item.get("relatedSymbols", [])]
        rows.append({
            "title": item.get("title"),
            "published": datetime.fromtimestamp(item["published"], tz=timezone.utc),
            "provider": item.get("provider", {}).get("name"),
            "related_symbols": related,
            "story_path": item.get("storyPath"),
            "urgency": item.get("urgency"),
        })

    return pd.DataFrame(rows)


def get_article(story_path):
    """
    Fetch the full article text from a TradingView news story path.

    :param story_path: Story path from get_news() (e.g. "/news/reuters.com,2026:newsml_...")
    :return: Article text as string
    """
    if story_path.startswith("http"):
        url = story_path
    else:
        url = f"{ARTICLE_BASE_URL}{story_path}"

    response = requests.get(url, headers=REQUEST_HEADERS, timeout=REQUEST_TIMEOUT)
    response.raise_for_status()

    # Extract article body from the HTML
    # TradingView wraps article content in a <div class="body-..."> with paragraphs
    html = response.text
    body = _extract_article_body(html)
    return body


def _extract_article_body(html):
    """Extract article text from TradingView news page HTML."""
    # Strategy 1: Extract from HTML <p> tags in the body div (most articles)
    body_match = re.search(r'class="body-\w+[^"]*">(.*)', html, re.DOTALL)
    if body_match:
        body_html = body_match.group(1)
        paragraphs = re.findall(r'<p[^>]*>(.*?)</p>', body_html, re.DOTALL)
        # Need at least 2 paragraphs to be a real article (not nav junk)
        if len(paragraphs) >= 2:
            lines = []
            for p in paragraphs:
                text = re.sub(r'<[^>]+>', '', p).strip()
                if text:
                    lines.append(text)
            if lines:
                return "\n\n".join(lines)

    # Strategy 2: Extract from embedded JSON ast_description (paywalled articles)
    return _extract_from_ast(html)


def _extract_from_ast(html):
    """Extract article text from TradingView's embedded JSON AST."""
    idx = html.find('"ast_description":{')
    if idx < 0:
        return ""

    start = idx + len('"ast_description":')
    depth = 0
    for i, c in enumerate(html[start:start + 20000]):
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
        if depth == 0:
            try:
                ast = json.loads(html[start:start + i + 1])
                return _ast_to_text(ast)
            except json.JSONDecodeError:
                return ""
    return ""


def _ast_to_text(node):
    """Recursively extract text from a TradingView AST node."""
    if isinstance(node, str):
        return node
    if isinstance(node, dict):
        children = node.get("children", [])
        texts = [_ast_to_text(c) for c in children]
        if node.get("type") == "p":
            return "\n\n".join(t for t in texts if t)
        return "".join(t for t in texts if t)
    return ""
