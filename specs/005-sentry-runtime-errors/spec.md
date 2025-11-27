# Feature Specification: Integración de Sentry para errores en tiempo de ejecución

**Feature Branch**: `005-sentry-runtime-errors`  
**Created**: 2025-11-26  
**Status**: Draft  
**Input**: User description: "Implementar sentry sdk para capturar errores en tiempo de ejecusión"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ver errores críticos en Sentry (Priority: P1)

Como operador del bot, cuando se produce un error en tiempo de ejecución en los flujos principales (webhook de alertas, endpoint de news monitor, comandos de Telegram o envío de WhatsApp), quiero que ese error se capture automáticamente en Sentry con suficiente contexto (entorno, canal, ruta, identificador de request) para poder diagnosticarlo sin depender solo de los logs de consola.

**Why this priority**: Sin visibilidad centralizada de errores es difícil reaccionar rápido ante incidentes en producción; esta historia convierte errores silenciosos en incidentes observables.

**Independent Test**: Forzar un error controlado en cada tipo de flujo (por ejemplo, simulando un fallo en una dependencia) y verificar que, en un entorno donde Sentry está habilitado, aparece un evento por cada error en el proyecto Sentry esperado, con tags que indiquen el canal y el entorno, sin cambiar la respuesta observable para el usuario final.

**Acceptance Scenarios**:

1. **Given** que Sentry está habilitado y se produce una excepción no controlada en el handler HTTP de `/api/webhook/alert`, **When** el proceso maneja el error y responde al cliente, **Then** se crea exactamente un evento de error en Sentry con información del endpoint, código de estado resultante y contexto básico del request.
2. **Given** que Sentry está habilitado y ocurre un fallo al enviar un mensaje por Telegram o WhatsApp después de agotar los reintentos internos, **When** el sistema registra ese fallo y aplica sus fallbacks actuales, **Then** se genera un evento en Sentry etiquetado con el canal afectado y el tipo de fallo (por ejemplo, error de API externa), sin cambiar el comportamiento hacia el usuario.

---

### User Story 2 - Mantener comportamiento actual de usuario y fallback (Priority: P2)

Como operador, quiero que la integración con Sentry no cambie las respuestas HTTP ni el comportamiento visible de Telegram/WhatsApp (incluidos los fallbacks ya implementados), de modo que el sistema siga siendo resiliente aunque Sentry esté mal configurado o caído.

**Why this priority**: La observabilidad no debe romper el servicio. La integración debe ser segura por defecto y degradarse de forma silenciosa si Sentry falla.

**Independent Test**: Ejecutar los mismos escenarios de error con y sin Sentry habilitado y comprobar que, desde el punto de vista del cliente HTTP o del usuario de Telegram/WhatsApp, las respuestas y mensajes son idénticos, incluso cuando Sentry no puede enviar eventos (por ejemplo, DSN inválido o red caída).

**Acceptance Scenarios**:

1. **Given** que Sentry está mal configurado (por ejemplo, DSN vacío o inválido), **When** se producen errores en los endpoints o canales, **Then** el sistema sigue devolviendo las mismas respuestas que antes de la integración y no introduce nuevos fallos 5xx ni bloqueos.
2. **Given** que Sentry experimenta un fallo temporal (por ejemplo, timeout), **When** se intenta notificar un error, **Then** el intento de notificación no bloquea el flujo principal y el sistema continúa aplicando sus fallbacks habituales (por ejemplo, envío al menos por un canal disponible).

---

### User Story 3 - Control de entornos y privacidad de datos (Priority: P3)

Como responsable de la plataforma, quiero poder decidir en qué entornos se activan los envíos a Sentry (desarrollo, preview, producción) y qué parte del contenido de las alertas/noticias se envía, para equilibrar visibilidad operacional, costos y privacidad.

**Why this priority**: No todos los entornos ni todos los datos deben tratarse igual; necesitamos una configuración clara para evitar enviar información sensible o ruido innecesario a Sentry.

**Independent Test**: Configurar el sistema con distintas combinaciones de variables de entorno (por ejemplo, sólo producción, producción+preview, desactivado en local) y verificar que los errores se reportan solo en los entornos configurados, y que el contenido incluido en los eventos sigue la política de privacidad definida.

**Acceptance Scenarios**:

1. **Given** que la configuración indica que solo producción envía eventos a Sentry, **When** se simula el mismo error en local y en producción, **Then** solo el entorno de producción genera eventos en Sentry, mientras que en local el error se maneja únicamente con logs de consola.
2. **Given** que existe una política de anonimización definida para el contenido de alertas y noticias, **When** se genera un evento en Sentry asociado a una alerta o análisis de noticias, **Then** el evento incluye únicamente los campos permitidos (por ejemplo, longitud del texto, tipo de evento, símbolo) y no incluye texto completo cuando la política así lo establezca.

---

### Edge Cases

- Sentry deshabilitado explícitamente (por configuración) aunque exista DSN: la aplicación debe comportarse igual que antes de la integración, sin intentos de envío y sin errores adicionales.
- DSN ausente o inválido en un entorno donde se espera que Sentry esté activo: el sistema debe registrar el problema mediante logs pero continuar ejecutándose y aplicar un comportamiento "fail-safe" (no intentar enviar eventos hasta que se corrija la configuración).
- Errores de muy alta frecuencia (por ejemplo, un bug que dispara miles de errores por minuto): la integración debe evitar ciclos de error incontrolados (por ejemplo, errores al reportar errores) y no debe comprometer la estabilidad del proceso.
- Errores originados en dependencias externas (Telegram, WhatsApp, Gemini, Azure, Binance, acortadores de URL) que ya cuentan con lógica de reintentos y fallbacks: la generación de eventos en Sentry debe reflejar los fallos persistentes sin duplicar eventos por cada intento individual.
- Escenarios de pruebas automatizadas (Jest) y entornos de desarrollo local: Sentry no debe enviar tráfico real salvo que se configure explícitamente y debe poder ser desactivado o reemplazado por un stub sin modificar el resto del código.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: El sistema MUST capturar en Sentry todos los errores en tiempo de ejecución que hoy resultan en respuestas de error en los endpoints HTTP principales (como `/api/webhook/alert` y `/api/news-monitor`), incluyendo como mínimo el siguiente contexto:

	- Identificación de la petición HTTP: método (`http.method`), ruta lógica o path (`http.target` o equivalente), código de respuesta final (`http.status_code`) y un identificador de request cuando exista (por ejemplo, un header `X-Request-ID` o un correlativo interno).
	- Canal y feature de origen: tags como `channel=http-alert|news-monitor|telegram|whatsapp` y `feature=gemini-grounding|news-monitor|...` que permitan agrupar incidentes por flujo funcional.
	- Entorno lógico y release: un tag `environment=production|preview|development|test` y un identificador de release derivado de la versión desplegada (por ejemplo, commit SHA o etiqueta de despliegue).
	- Información básica del error: tipo de error de alto nivel (por ejemplo, `runtime_error`, `external_failure`), mensaje de error y, cuando sea posible, un stack trace resumido.
	- Metadatos específicos del flujo: para alertas, al menos símbolo(s) afectados y tipo de alerta; para news monitor, al menos símbolo(s) y tipo de evento/noticia.

- **FR-002**: El sistema MUST capturar en Sentry excepciones no controladas y rechazos de promesas no gestionados a nivel de proceso, de forma que al menos un evento por incidente quede registrado antes de que el proceso termine o se reinicie.

- **FR-003**: La integración con Sentry MUST ser no intrusiva en la experiencia de usuario: la semántica de las respuestas HTTP y el comportamiento de envío de mensajes (Telegram, WhatsApp) MUST permanecer inalterados aunque Sentry falle, esté mal configurado o no esté disponible.

- **FR-004**: Los operadores MUST poder controlar mediante configuración basada en entorno qué despliegues envían eventos a Sentry y con qué etiquetas de entorno y versión (por ejemplo, distinguir producción, preview y desarrollo, y asociar cada evento a un identificador de release derivado de la versión desplegada). Esta capacidad de control aplica a todos los entornos lógicos; el caso particular de entornos de preview se detalla en FR-011.

- **FR-005**: Para cada fallo persistente en integraciones externas (por ejemplo, APIs de Telegram, WhatsApp, Gemini, Azure, acortadores de URL o Binance) que ya cuentan con lógica de reintentos, el sistema MUST generar un evento de error en Sentry cuando se agoten todos los reintentos sin éxito, incluyendo metadatos sobre el servicio afectado, número de intentos y duración total aproximada.

- **FR-006**: La integración MUST evitar generar eventos de error en Sentry para comportamientos explícitamente esperados y controlados, como características deshabilitadas por `feature flags` (por ejemplo, `ENABLE_WHATSAPP_ALERTS=false`, `ENABLE_NEWS_MONITOR=false`), de forma que Sentry refleje incidentes reales y no ruido de configuración prevista.

- **FR-007**: Los eventos de error asociados a contenido de alertas o noticias MUST respetar una política clara de tratamiento de datos configurable.

	- Por defecto, cuando la integración de monitoring está habilitada, el sistema MUST enviar a la herramienta de monitoring el texto completo de la alerta/noticia junto con metadatos relevantes (por ejemplo, longitud del mensaje, símbolo, tipo de evento), siempre que el acceso a dicha herramienta esté restringido a operadores autorizados y se respeten las políticas internas de privacidad.
	- La configuración de monitoring MUST exponer un flag (por ejemplo, `sendAlertContent`) que permita desactivar el envío del texto completo. Cuando `sendAlertContent=false`, los eventos de error MUST incluir únicamente información resumida y metadatos (por ejemplo, `textLength`, número de símbolos, tipo de evento), sin el cuerpo íntegro del mensaje.
	- La política elegida (texto completo vs solo metadatos) MUST poder definirse por entorno (por ejemplo, producción vs preview vs desarrollo) mediante configuración, sin requerir cambios en el código de los handlers.

- **FR-008**: La solución MUST permitir que los tests automatizados y entornos de desarrollo local ejecuten el código sin necesidad de un proyecto Sentry real, pudiendo desactivar o reemplazar fácilmente la integración (por ejemplo, mediante configuración o un wrapper de monitoring) sin modificar los flujos de negocio.

- **FR-009**: Los eventos registrados en Sentry MUST incluir tags o atributos que permitan clasificar el origen del error (por ejemplo, `channel=telegram|whatsapp|http-alert|news-monitor`, `feature=gemini-grounding|news-monitor` o similar), de modo que los operadores puedan filtrar y agrupar errores por canal o funcionalidad.

- **FR-010**: Para esta feature, el uso de la herramienta de monitoring MUST centrarse en la captura de errores; no es requisito registrar métricas de rendimiento ni trazas de solicitudes. Si en el futuro se habilita tracing/performance, dicha capacidad deberá poder activarse o desactivarse mediante configuración sin afectar a la semántica ni al tratamiento de los errores.

- **FR-011**: Como especialización de FR-004 para entornos de preview, la activación de la herramienta de monitoring en entornos de preview (por ejemplo, despliegues asociados a pull requests) MUST permitir que estos entornos reporten al mismo proyecto que producción, etiquetando de forma explícita los eventos con un entorno lógico como `preview`, y que dicha activación pueda configurarse de forma independiente a la de producción.

### Key Entities *(include if feature involves data)*

- **ErrorEvent**: Representa un incidente de error capturado por el sistema de monitoring. Atributos clave: identificador del evento, timestamp, severidad, entorno lógico (production/preview/development), canal/origen (HTTP, Telegram, WhatsApp, news monitor, integración externa), mensaje de error de alto nivel y, cuando esté permitido, fragmentos anonimizados de contenido relevante.

- **MonitoringConfiguration**: Configuración de observabilidad controlada por variables de entorno o parámetros operativos. Atributos clave: credenciales del proveedor de monitoring (por ejemplo, DSN de Sentry), banderas de activación por entorno, reglas de anonimización de contenido, política de activación de tracing y niveles de muestreo.

- **RuntimeChannel**: Representa los distintos flujos donde pueden aparecer errores (endpoints HTTP, comandos de Telegram, envío de mensajes WhatsApp, pipelines de grounding y news monitor). Atributos clave: nombre del canal, identificadores de ruta o comando, y metadatos que se usan como tags en los eventos de error.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: En un entorno donde Sentry está habilitado, al provocar de forma controlada un error en cada flujo principal (webhook de alertas, news monitor, Telegram, WhatsApp), al menos el 95% de estos incidentes generan un evento visible en la herramienta de monitoring con contexto suficiente para entender el origen (canal, entorno, tipo de error) sin necesidad de revisar los logs crudos.

- **SC-002**: La integración de Sentry no introduce regresiones visibles para los usuarios: bajo la misma carga y escenarios de error que antes de la integración, el porcentaje de respuestas HTTP 5xx u otros fallos visibles para el usuario no aumenta en más de un 5% debido a la propia instrumentación.

- **SC-003**: Los eventos generados en entornos diferentes (por ejemplo, producción vs preview vs desarrollo) son distinguibles en la herramienta de monitoring mediante etiquetas de entorno y versión, de modo que los operadores puedan filtrar incidentes de producción sin ruido de entornos no productivos.

- **SC-004**: Al menos el 90% de los incidentes críticos en producción (según la definición de C1) —tanto errores 5xx sostenidos en `/api/webhook/alert` o `/api/news-monitor` como fallos definitivos de entrega tras reintentos en Telegram/WhatsApp— son detectables y triageables solo con la información disponible en la herramienta de monitoring (eventos y tags de Sentry), sin necesidad de acceso adicional a los servidores ni a logs fuera del sistema.

## Clarifications

### C1 – Definición de "incidente crítico en producción"

Para efectos de esta especificación y de SC-004, un **incidente crítico en producción** se define como cualquiera de los siguientes casos:

1. **Errores HTTP 5xx sostenidos** en los endpoints de alertas o news monitor (por ejemplo, `/api/webhook/alert` o `/api/news-monitor`), es decir, una condición en la que el servicio devuelve códigos 5xx de forma continuada durante un intervalo de tiempo apreciable o un número significativo de requests consecutivos (por ejemplo, un bug de código o un fallo persistente de infraestructura).
2. **Fallo definitivo de entrega tras reintentos** en los canales soportados (Telegram, WhatsApp, HTTP de alertas/news monitor), es decir, casos en los que un mensaje o alerta no se entrega por ningún canal previsto después de agotar los reintentos y fallbacks configurados.

Cuando el servicio se ejecuta en Render y el entorno lógico se configura como `production` o `preview`, los eventos de error MUST, siempre que sea razonable, incluir tags derivados de las variables de entorno por defecto de Render, si están presentes. En particular:

- Identidad de servicio e instancia:
	- `RENDER_SERVICE_ID`, `RENDER_SERVICE_NAME`, `RENDER_SERVICE_TYPE` (por ejemplo, `web`, `worker`)
	- `RENDER_INSTANCE_ID` y `RENDER_DISCOVERY_SERVICE` (útiles para incidentes en servicios escalados)
- Git y release:
	- `RENDER_GIT_COMMIT`, `RENDER_GIT_BRANCH`, `RENDER_GIT_REPO_SLUG` para asociar eventos a una release concreta y a la rama de despliegue
- Acceso externo:
	- `RENDER_EXTERNAL_HOSTNAME`, `RENDER_EXTERNAL_URL` para identificar el hostname/URL público del servicio afectado
- Contexto de entorno Render:
	- `RENDER=true` (indicador de que corre en Render)
	- `IS_PULL_REQUEST=true|false` para diferenciar servicios de preview asociados a pull requests

Estos valores SHOULD mapearse a tags y contextos de Sentry (por ejemplo, `service.id`, `service.name`, `service.type`, `service.instance`, `git.commit`, `git.branch`, `deployment.url`) únicamente en entornos `production` y `preview`. En entornos de desarrollo/local o de test, su presencia es opcional y no es requisito enriquecer los eventos con estos metadatos.

### Assumptions

- La organización dispone (o dispondrá) de un proyecto y credenciales válidas de Sentry u otra herramienta equivalente de monitoring para entornos donde se desee observabilidad centralizada.
- Es aceptable enviar a la herramienta de monitoring metadatos técnicos (como nombres de rutas, símbolos, identificadores de request, códigos de error y banderas de entorno) siempre que se respeten las reglas de privacidad acordadas sobre el contenido de mensajes.
- La política actual de tratamiento de contenido de alertas y noticias descrita en FR-007 podrá ajustarse en el futuro si cambian los requisitos de privacidad, sin alterar el objetivo principal de observabilidad definido en esta especificación.

