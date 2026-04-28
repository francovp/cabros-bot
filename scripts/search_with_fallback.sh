#!/bin/bash
# Wrapper para búsquedas web con fallback: Brave → Tavily
# Uso: ./search_with_fallback.sh "tu consulta aquí"

QUERY="$1"
if [ -z "$QUERY" ]; then
  echo "Error: Se requiere una consulta de búsqueda"
  echo "Uso: $0 \"consulta de búsqueda\""
  exit 1
fi

# Extraer API keys desde TOOLS.md (formato conocido)
BRAVE_KEY=$(grep -A1 'Brave Search' /home/ubuntu/.openclaw/workspace/TOOLS.md | tail -1 | sed 's/.*API Key: //')
TAVILY_KEY=$(grep -A1 'Tavily Search' /home/ubuntu/.openclaw/workspace/TOOLS.md | tail -1 | sed 's/.*API Key: //')

# Intentar con Brave Search primero
echo "Intentando búsqueda con Brave Search..."
BRAVE_RESULT=$(openclaw brave_search query="$QUERY" count=5 2>/dev/null) || BRAVE_RESULT=""

if [ -n "$BRAVE_RESULT" ] && [ "$BRAVE_RESULT" != "" ]; then
  echo "Búsqueda exitosa con Brave Search:"
  echo "$BRAVE_RESULT"
  exit 0
else
  echo "Brave Search falló o no devolvió resultados. Probando con Tavily..."
fi

# Fallback a Tavily Search
echo "Intentando búsqueda con Tavily Search..."
TAVILY_RESULT=$(openclaw tavily_search query="$QUERY" maxResults=5 2>/dev/null) || TAVILY_RESULT=""

if [ -n "$TAVILY_RESULT" ] && [ "$TAVILY_RESULT" != "" ]; then
  echo "Búsqueda exitosa con Tavily Search:"
  echo "$TAVILY_RESULT"
  exit 0
else
  echo "Ambos servicios fallaron. No se pudieron obtener resultados."
  exit 1
fi