# Feature Specification: Funcionalidad "Post Alert" con grounding (Gemini + Google Search)

**Feature Branch**: `001-gemini-grounding-alert`  
**Created**: 2025-10-26  
**Status**: Draft  
**Input**: User description: "Añade una funcionalidad para postAlert que utilizando el text + un system prompt, consulte a gemini implementando Grounding with Google Search para obtener fuentes para dar más contexto al text obtenido"

## User Scenarios & Testing *(mandatory)*

<!--
  IMPORTANT: User stories should be PRIORITIZED as user journeys ordered by importance.
  Each user story/journey must be INDEPENDENTLY TESTABLE - meaning if you implement just ONE of them,
  you should still have a viable MVP (Minimum Viable Product) that delivers value.
  
  Assign priorities (P1, P2, P3, etc.) to each story, where P1 is the most critical.
  Think of each story as a standalone slice of functionality that can be:
  - Developed independently
  - Tested independently
  - Deployed independently
  - Demonstrated to users independently
-->

### User Story 1 - Enriquecer alertas con contexto verificado (Priority: P1)

Como operador del bot, cuando el servicio reciba un webhook de alerta con un texto, quiero que el sistema consulte a un modelo (Gemini) junto con resultados de búsqueda de Google (Grounding) y que devuelva un texto enriquecido que incluya un breve resumen y las fuentes encontradas, de forma que los destinatarios del chat de Telegram reciban contexto verificado y enlaces a las fuentes.

**Why this priority**: Aporta valor inmediato: las alertas contienen contexto y fuentes, reduciendo ambigüedad y soporte manual.

**Independent Test**: Enviar un POST a `/api/webhook/alert` con cuerpo texto; verificar que el mensaje de Telegram contiene (a) resumen generado, (b) lista de fuentes/URLs y (c) original o versión enriquecida.

**Acceptance Scenarios**:

1. **Given** que llega un webhook con texto plano, **When** el handler `postAlert` procesa el mensaje y las APIs externas (Search + Gemini) están disponibles, **Then** el bot envía a `TELEGRAM_CHAT_ID` un mensaje que contiene el resumen y 1..N fuentes con URLs.
2. **Given** que la API de búsqueda no está disponible, **When** se procesa el webhook, **Then** el bot envía el texto original y una nota indicando que no fue posible obtener fuentes (fall back).

---

### User Story 2 - Fallbacks y notificaciones de administrador (Priority: P2)

Como administrador, quiero recibir una notificación (opcional) cuando la pipeline de enriquecimiento falle por errores de API o tiempos de espera para poder actuar.

**Why this priority**: Mantiene observabilidad del sistema y permite acciones manuales si la automatización falla.

**Independent Test**: Simular error en la búsqueda o en Gemini y verificar que se envía un mensaje al `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` (si configurado) con detalle del fallo.

**Acceptance Scenarios**:

1. **Given** que la llamada a la API de búsqueda devuelve error 5xx, **When** el handler procesa la alerta, **Then** envía el texto original al chat principal y una notificación al chat de administradores con el error.

---

### User Story 3 - Configuración mínima y control (Priority: P3)

Como operador quiero poder habilitar/deshabilitar el enriquecimiento vía variables de entorno (`ENABLE_GEMINI_GROUNDING`) y configurar el número máximo de fuentes retornadas, para controlar costos y latencia.

**Why this priority**: Control operativo y seguridad financiera (costos de LLM/API).

**Independent Test**: Cambiar `ENABLE_GEMINI_GROUNDING=false` y verificar que el handler no llama a Gemini/Google Search y reenvía el texto original.

**Acceptance Scenarios**:

1. **Given** `ENABLE_GEMINI_GROUNDING=false`, **When** llega una alerta, **Then** se envía el texto original tal cual sin llamadas externas.

---

[Add more user stories as needed, each with an assigned priority]

### Edge Cases

- Alertas muy largas ( > 4000 caracteres): recortar o resumir antes de enviar a búsqueda/LLM para evitar costos y límites.
- Contenido en idiomas distintos al inglés: conservar idioma original, y solicitar a Gemini respuesta en el mismo idioma si es posible.
- Fuentes duplicadas o inaccesibles (HTTP 403/404): filtrar y reportar número de fuentes efectivas incluidas.
- Latencia alta en APIs externas: si el tiempo total excede el umbral configurable (ej. 8s), enviar fallback con nota "contexto no disponible".

## Requirements *(mandatory)*

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right functional requirements.
-->

### Functional Requirements

- **FR-001**: When `postAlert` receives a webhook body (text/plain or JSON with `text`), and grounding is enabled, the system MUST perform a grounding pipeline: derive a search query from the text, collect the top-K search results as evidence, and pass them as context to the LLM along with a system prompt and the original text.

- **FR-002**: The system MUST include, for each included source, a short citation (title/snippet) and a URL in the Telegram message when available.

- **FR-003**: The system MUST gracefully fallback to sending the original text if search or LLM calls fail or exceed the configured latency threshold; when falling back, it MUST include a short note explaining why sources are not present.

- **FR-004**: The grounding pipeline MUST be configurable via environment or runtime configuration so operators can enable/disable grounding, set maximum sources to include, and tune timeouts.

- **FR-005**: The system MUST log (console) the steps and any errors for observability and include minimal structured info (which step failed, status codes).

- **FR-006**: The system MUST support a safe default behavior: if grounding credentials or necessary configuration are missing, the enrichment is disabled and the original text is forwarded.

- **FR-007**: Search results should be passed and/or displayed to users with a default of 3 (configurable).
- **FR-008**: The enriched content (summary + sources) MUST be added after the original alert text in the Telegram message.
- **FR-010**: The system MUST filter out-of-scope content (e.g., sensitive data, irrelevant topics) before sending to external APIs.
- **FR-011**: The system MUST use a dedicated, configurable prompt to derive the search query from the alert text.
- **FR-012**: The system MUST validate incoming webhook payloads to prevent injection or malformed data.

### Key Entities *(include if feature involves data)*

- **Alert**: incoming webhook payload; key attributes: `text` (string), `received_at` (timestamp), optional metadata.
- **SearchResult**: { title, snippet, url, sourceDomain }
- **GroundedContext**: collection of `SearchResult` objects used as evidence for Gemini prompt.
- **GeminiResponse**: { summary, confidence? (optional), citations: [SearchResult] }
- **TelegramMessage**: final message text (string) and optional parse mode metadata.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: When external APIs are available and `ENABLE_GEMINI_GROUNDING=true`, at least 90% of processed alerts should be delivered to Telegram enriched with >=1 source citation.
- **SC-002**: 90% of enriched alerts are delivered within `GROUNDING_TIMEOUT_MS` (default 8000 ms).
- **SC-003**: When enrichment is disabled or fails, 100% of alerts are still forwarded (no data loss).
- **SC-004**: Admin notification is sent for 95% of enrichment failures that return non-2xx status codes (if `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` configured).

### Assumptions

- The environment will provide API keys via env vars when enrichment is desired. Primary credential required: `GEMINI_API_KEY`.
- Gemini API supports providing grounding context (either as system prompt + documents or a context block) and returning a concise summary with citations.
- The project owner will confirm the search provider and the policy for including external links in Telegram messages (some chats may block links).

---

The spec is ready for refinement. There are a small number of clarifying questions below which affect implementation details; see the checklist and the questions section.

## Clarifications

### Session 2025-10-26

- Q: Should the system explicitly define out-of-scope content for processing by external APIs (e.g., sensitive data, irrelevant topics)? → A: Yes, explícitamente definir el contenido fuera de alcance.

- Q: How should the search query be derived from the alert text? → A: Use a dedicated, configurable prompt.
- Q: Should the enriched message replace the original text or be appended/prepended? → A: Append: the enriched content (summary + sources) MUST be added after the original alert text in the Telegram message.
- Q: How many search results should be passed and/or displayed to users? → A: Default: 3 (configurable).
- Q: Which search provider/implementation should we use for grounding? → A: Use Gemini's googleSearch groundingTool via the latest `genai` package (no custom search client).
