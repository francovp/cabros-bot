#!/bin/bash
# Wrapper para búsquedas web con fallback usando curl directo: Brave → Tavily

QUERY="$1"
if [ -z "$QUERY" ]; then
  echo "Error: Se requiere una consulta de búsqueda"
  echo "Uso: $0 \"consulta de búsqueda\""
  exit 1
fi

# Extraer API keys desde TOOLS.md
BRAVE_KEY=$(grep -A1 'Brave Search' /home/ubuntu/.openclaw/workspace/TOOLS.md | tail -1 | sed 's/.*API Key: //' | tr -d '`')
TAVILY_KEY=$(grep -A1 'Tavily Search' /home/ubuntu/.openclaw/workspace/TOOLS.md | tail -1 | sed 's/.*API Key: //' | tr -d '`')

# URL codificada para la consulta
ENCODED_QUERY=$(echo "$QUERY" | jq -sRr @uri)

echo "Intentando búsqueda con Brave Search..."

# Intentar con Brave Search primero
BRAVE_RESULT=$(curl -s -X GET "https://api.search.brave.com/res/v1/web/search?q=${ENCODED_QUERY}&count=5" \
  -H "Accept: application/json" \
  -H "Accept-Encoding: gzip" \
  -H "X-Subscription-Token: ${BRAVE_KEY}" 2>/dev/null) || BRAVE_RESULT=""

if [ -n "$BRAVE_RESULT" ] && [ "$BRAVE_RESULT" != "" ] && [ "$(echo "$BRAVE_RESULT" | jq -r '.web // empty' 2>/dev/null | wc -l)" -gt 0 ]; then
  echo "Búsqueda exitosa con Brave Search:"
  echo "$BRAVE_RESULT" | jq -r '.web.results[] | "Título: \(.title)\nURL: \(.url)\nDescripción: \(.description)\n"' | head -20
  exit 0
else
  echo "Brave Search falló o no devolvió resultados válidos. Probando con Tavily..."
fi

# Fallback a Tavily Search
echo "Intentando búsqueda con Tavily Search..."

TAVILY_RESULT=$(curl -s -X POST "https://api.tavily.com/search" \
  -H "Content-Type: application/json" \
  -d "{\"api_key\":\"${TAVILY_KEY}\",\"query\":\"${QUERY}\",\"max_results\":5}" 2>/dev/null) || TAVILY_RESULT=""

if [ -n "$TAVILY_RESULT" ] && [ "$TAVILY_RESULT" != "" ] && [ "$(echo "$TAVILY_RESULT" | jq -r '.results // empty' 2>/dev/null | wc -l)" -gt 0 ]; then
  echo "Búsqueda exitosa con Tavily Search:"
  echo "$TAVILY_RESULT" | jq -r '.results[] | "Título: \(.title)\nURL: \(.url)\nContenido: \(.content)\n"' | head -20
  exit 0
else
  echo "Ambos servicios fallaron. No se pudieron obtener resultados."
  exit 1
fi