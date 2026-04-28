# MEMORY.md — Long-term Memory

## Wiki Personal (LLM Knowledge Base)
Franco tiene un wiki personal en Obsidian que sigue el patrón LLM Wiki de Karpathy.

**Ruta:** `~/OneDrive/obsidian-vault/personal/wiki/`

**Estructura completa (3 capas):**
```
wiki/
├── CLAUDE.md           # Schema — instrucciones para mantener el wiki
├── index.md            # Catálogo de todas las páginas
├── log.md              # Registro cronológico (ingests, queries, lints)
├── raw/                # Fuentes originales (inmutables)
│   ├── articles/
│   ├── papers/
│   └── notes/
└── pages/              # Contenido generado por IA
    ├── summaries/      # Summaries de fuentes
    ├── entities/       # Entidades (personas, empresas, conceptos específicos)
    ├── concepts/       # Conceptos y temas abstractos
    └── syntheses/      # Análisis que conectan múltiples fuentes
```

**Para qué sirve:**
- Guardar conocimiento persistente que no se pierde entre sesiones
- Cada fuente ingestionada genera summaries, actualiza entities y concepts
- El wiki crece y se mantiene solo (cross-references, contradictions, updates)
- **Implementación completa del patrón**: Ya tengo los 3 tipos de pages (summaries, entities, concepts, syntheses) trabajando

**Workflows implementados:**
1. **Ingest completo**: Guardar source → crear summary → actualizar entities/concepts → actualizar index → agregar a log
2. **Query mejorada**: Leer index → leer páginas relevantes → sintetizar respuesta  
3. **Preparado para lint**: Estructura lista para buscar contradicciones, páginas huérfanas, etc.
4. **Síntesis activas**: Creando páginas que conectan múltiples fuentes (ej: AI Investment Boom 2026)

**Regla:** Cuando Franco pregunte sobre algo que ya está en la wiki, responder desde ahí antes de buscar en la web.

**Regla PDFs:** Franco envía PDFs para que los guarde en la wiki SIEMPRE. Inbound PDFs van a `raw/articles/` y siempre crear `pages/summaries/summary-*.md` luego. Actualizar `index.md`, `entities/`, `concepts/` si aplica, y `log.md` después de cada ingest.

** canales:**
- La wiki funciona como archivo de texto plano accesible desde cualquier canal
- Telegram y WhatsApp son sessions separadas; la wiki no se comparte automáticamente entre ellas
- Pero puedo leer/escribir la wiki desde cualquier session usando las herramientas de archivo

## Preferencias de Comunicación
- **Español:** Estilo chileno (modismos 2020s)
- **Inglés:** Estilo americano, directo
- **WhatsApp:** Limitado markdown (bold con `*`, italic con `_`, código con backticks)
- **No mencionar SRE/DevOps** cuando se refiera a Franco
