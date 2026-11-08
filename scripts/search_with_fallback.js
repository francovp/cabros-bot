#!/usr/bin/env node
// Wrapper para búsquedas web con fallback: Brave → Tavily
// Uso: node search_with_fallback.js "tu consulta aquí"

const { execSync } = require('child_process');

const query = process.argv[2];
if (!query) {
  console.error('Error: Se requiere una consulta de búsqueda');
  console.error('Uso: node search_with_fallback.js "consulta de búsqueda"');
  process.exit(1);
}

// Función para intentar una búsqueda y capturar errores
function trySearch(tool, args) {
  try {
    const result = execSync(`openclaw ${tool} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    return result.trim();
  } catch (error) {
    return null;
  }
}

// Intentar con Brave Search primero
console.log('Intentando búsqueda con Brave Search...');
let result = trySearch('brave_search', `query="${query}" count=5`);

if (result) {
  console.log('Búsqueda exitosa con Brave Search:');
  console.log(result);
  process.exit(0);
} else {
  console.log('Brave Search falló o no devolvió resultados. Probando con Tavily...');
}

// Fallback a Tavily Search
console.log('Intentando búsqueda con Tavily Search...');
result = trySearch('tavily_search', `query="${query}" maxResults=5`);

if (result) {
  console.log('Búsqueda exitosa con Tavily Search:');
  console.log(result);
  process.exit(0);
} else {
  console.error('Ambos servicios fallaron. No se pudieron obtener resultados.');
  process.exit(1);
}