# Feature Specification: Multi-Channel Alerts (WhatsApp & Telegram)

**Feature Branch**: `002-whatsapp-alerts`  
**Created**: 2025-10-29  
**Status**: Draft  
**Input**: User description: "Add WhatsApp Alert Channel to Webhook with Green API integration"

## Clarifications

### Session 2025-10-29

- Q: When WhatsApp API calls fail, what should the system do? → A: Use retry with exponential backoff (1s → 2s → 4s, max 3 retries). If all retries exhausted, return 200 OK to webhook caller, log the failure, and notify admin.
- Q: How should the system handle alert text that exceeds reasonable length constraints? → A: Truncate alert message body to 20,000 characters (GreenAPI limit); add "…" suffix if truncated. For preview title, trust GreenAPI to handle; don't pre-validate title length.
- Q: When GreenAPI returns rate-limit errors, should the system implement a global backoff strategy or handle each message independently? → A: Per-message exponential backoff. Each message retries independently (1s → 2s → 4s). GreenAPI sendMessage has 50 RPS limit, sufficient for typical alert volumes without global coordination.
- Q: How should admin notifications be triggered when WhatsApp delivery fails after retries? → A: Via Telegram channel using existing `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` to send admin alerts about WhatsApp failures.
- Q: Should enriched alert content be sent to both channels identically, or should WhatsApp receive plain text while Telegram receives enriched content? → A: Both channels get enriched content, formatted appropriately per channel. Make only 1 grounding request and reuse data for both channels. WhatsApp supports limited markdown: underscore for italic, asterisk for bold, tilde for strikethrough, backticks for code, triple-backticks for monospace, greater-than for quotes, asterisk or hyphen for lists.

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

### User Story 1 - Send Trading Alerts to WhatsApp Group (Priority: P1)

Trading View sends an alert webhook to the bot. The alert should be delivered to a WhatsApp group via the Green API, with a customizable title preview so recipients can see the alert context before opening the message.

**Why this priority**: This is the core feature request and primary use case. Delivering alerts to WhatsApp enables the user to reach a trading community via their preferred messaging platform without requiring Telegram.

**Independent Test**: Can be fully tested by sending an HTTP POST request to the alert webhook and verifying the message appears in the target WhatsApp group with proper formatting and custom preview.

**Acceptance Scenarios**:

1. **Given** a webhook is configured with a valid Green API URL and credentials, **When** an alert is posted to `/api/webhook/alert` with alert text, **Then** the alert is sent to the configured WhatsApp chat ID with the message text and trading view alert preview.
2. **Given** WhatsApp delivery is enabled via `ENABLE_WHATSAPP_ALERTS=true`, **When** an alert webhook is received, **Then** the message reaches the WhatsApp group within 5 seconds.
3. **Given** an alert contains special characters or emoji, **When** it is sent to WhatsApp, **Then** the message is properly formatted without encoding errors or lost content.

---

### User Story 2 - Receive Alerts on Both Telegram and WhatsApp Simultaneously (Priority: P2)

A system administrator wants to ensure critical alerts reach multiple channels for redundancy and broader visibility. When an alert is posted, it should be delivered to both Telegram (existing) and WhatsApp (new) if both are enabled.

**Why this priority**: Enables multi-channel delivery strategy for resilience and reaching different audience segments. Important for reliability but not critical if only one channel is available.

**Independent Test**: Can be tested by sending an alert with both Telegram and WhatsApp enabled, then verifying the message appears in both chat destinations.

**Acceptance Scenarios**:

1. **Given** both `ENABLE_TELEGRAM_BOT=true` and `ENABLE_WHATSAPP_ALERTS=true`, **When** an alert is received, **Then** the message is sent to both Telegram chat and WhatsApp group.
2. **Given** Telegram delivery fails but WhatsApp is configured, **When** an alert is posted, **Then** the message is still delivered to WhatsApp without blocking.
3. **Given** WhatsApp delivery fails, **When** an alert is posted, **Then** the system logs the failure and notifies the admin if configured, without preventing Telegram delivery.

---

### User Story 3 - Configure WhatsApp Settings via Environment Variables (Priority: P2)

System administrators need to configure WhatsApp integration securely via environment variables without modifying code, following the same pattern as Telegram configuration.

**Why this priority**: Essential for production deployments. Enables teams to configure credentials securely and support multiple deployment environments.

**Independent Test**: Can be tested by setting environment variables and verifying the application initializes the WhatsApp service correctly with the provided credentials.

**Acceptance Scenarios**:

1. **Given** `WHATSAPP_API_URL`, `WHATSAPP_API_KEY`, and `WHATSAPP_CHAT_ID` are provided, **When** the application starts, **Then** the WhatsApp notification service is configured and ready to send messages.
2. **Given** `ENABLE_WHATSAPP_ALERTS=false`, **When** an alert is posted, **Then** the WhatsApp service is not called and no message is sent.
3. **Given** `ENABLE_WHATSAPP_ALERTS=true` but `WHATSAPP_API_KEY` is missing, **When** the application starts, **Then** an error is logged indicating the missing configuration.

---

### User Story 4 - Support Graceful Fallback for Missing WhatsApp Configuration (Priority: P3)

When WhatsApp is not configured, the system should gracefully degrade and continue sending alerts via Telegram without errors.

**Why this priority**: Maintains backward compatibility and allows gradual migration. Users can enable WhatsApp at their own pace without breaking existing setups.

**Independent Test**: Can be tested by omitting WhatsApp environment variables and verifying alerts are still delivered to Telegram.

**Acceptance Scenarios**:

1. **Given** WhatsApp configuration is not provided, **When** an alert is posted, **Then** it is delivered to Telegram (if configured) without errors or warnings.
2. **Given** only Telegram is configured, **When** the application starts, **Then** WhatsApp service initialization is skipped gracefully.

### Edge Cases

- What happens when WhatsApp API returns an error response (rate limit, auth failure, network timeout)?
- How does the system handle WhatsApp messages that are too long (character limit on chat preview)?
- What happens if the Green API endpoint is temporarily unavailable?
- How are multi-line alert texts handled in WhatsApp's custom preview field?
- What happens if `WHATSAPP_CHAT_ID` contains invalid format or disconnected number?

## Requirements *(mandatory)*

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right functional requirements.
-->

- **FR-001**: System MUST accept `WHATSAPP_API_URL` environment variable pointing to the Green API base endpoint (e.g., `https://7107.api.green-api.com/waInstance7107356806/sendMessage/`) where the API key from `WHATSAPP_API_KEY` is appended to construct the final URL: `${WHATSAPP_API_URL}${WHATSAPP_API_KEY}`
- **FR-002**: System MUST accept `WHATSAPP_API_KEY` environment variable containing the API key to be appended to the `WHATSAPP_API_URL`
- **FR-003**: System MUST accept `WHATSAPP_CHAT_ID` environment variable for destination WhatsApp chat/group ID
- **FR-004**: System MUST accept `ENABLE_WHATSAPP_ALERTS` boolean environment variable (default: `false`) to gate WhatsApp functionality
- **FR-005**: System MUST create a notification service abstraction that supports multiple channels (Telegram, WhatsApp, extensible for future channels)
- **FR-006**: System MUST implement a WhatsApp notification service that sends messages to the Green API with required payload structure: `{ chatId, message, customPreview: { title } }`
- **FR-007**: System MUST send alert messages to all enabled notification channels when an alert webhook is received
- **FR-008**: System MUST handle WhatsApp service errors gracefully without preventing delivery to other enabled channels. When a WhatsApp send fails, the system MUST retry with exponential backoff (1s → 2s → 4s, maximum 3 retries). If all retries fail, the system MUST return HTTP 200 OK to the webhook caller, log the failure at ERROR level, and send an admin notification to `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` (if configured).
- **FR-009**: System MUST include a customizable "Trading View Alert" title in the WhatsApp message preview
- **FR-010**: System MUST preserve the original alert text in WhatsApp messages. For enriched content, the system MUST convert Telegram MarkdownV2 formatting to WhatsApp-compatible markdown: bold (asterisk), italic (underscore), strikethrough (tilde), monospace (backticks), quotes (greater-than prefix), and lists (asterisk/hyphen or numbers). Unsupported formatting (e.g., nested formatting, links) MUST be stripped and replaced with plain text.
- **FR-010a**: System MUST truncate alert message body to a maximum of 20,000 characters before sending to GreenAPI. If truncation occurs, the system MUST append "…" to indicate truncation.
- **FR-011**: System MUST validate WhatsApp configuration on application startup and log warnings if configuration is incomplete
- **FR-012**: System MUST support the existing Telegram alert enrichment (Gemini grounding). The system MUST make a single grounding request per alert and reuse the enriched data for both Telegram and WhatsApp channels. Telegram receives enriched content formatted with MarkdownV2; WhatsApp receives enriched content formatted with WhatsApp-compatible markdown (bold, italic, strikethrough, code, quotes, lists).
- **FR-013**: System MUST log all WhatsApp send attempts (success, failure, retry) for monitoring and debugging

### Key Entities

- **NotificationChannel**: Abstract interface defining how to send alert messages
  - `isEnabled(): boolean` — Whether this channel is configured
  - `send(alert: Alert): Promise<SendResult>` — Send alert to this channel
  - `name: string` — Identifier for the channel

- **WhatsAppService**: Implementation of NotificationChannel for Green API
  - `apiUrl: string` — Green API base endpoint (e.g., `https://7107.api.green-api.com/waInstance7107356806/sendMessage/`)
  - `apiKey: string` — Authentication key appended to `apiUrl` to form complete endpoint
  - `chatId: string` — Destination chat/group ID
  - `send(alert: Alert): Promise<SendResult>` — POST to `${apiUrl}${apiKey}` with formatted payload

- **TelegramService**: Existing Telegram channel (refactored from current implementation)
  - `botToken: string` — Telegram bot token
  - `chatId: string` — Destination Telegram chat
  - `send(alert: Alert): Promise<SendResult>` — Send via Telegram API

- **Alert**: Existing alert entity (unchanged)
  - `text: string` — Alert message body
  - `enriched?: EnrichedAlert` — Optional grounding data from Gemini
  - `metadata?: object` — Optional additional data

- **SendResult**: Response from notification channel
  - `success: boolean` — Whether send succeeded
  - `messageId?: string` — Channel-specific message ID if successful
  - `channel: string` — Which channel this result is from
  - `error?: string` — Error message if failed

## Success Criteria *(mandatory)*

<!--
  ACTION REQUIRED: Define measurable success criteria.
  These must be technology-agnostic and measurable.
-->

- **SC-001**: WhatsApp alerts are delivered to the configured group within 5 seconds of webhook receipt
- **SC-002**: Alert delivery succeeds for 99% of valid webhook requests when WhatsApp credentials are correct
- **SC-003**: Alerts are sent to both Telegram and WhatsApp simultaneously when both are enabled, with no additional latency impact
- **SC-004**: System correctly handles and logs WhatsApp API errors without crashing or blocking other channels
- **SC-005**: Existing Telegram alert functionality continues to work without any breaking changes when WhatsApp is not configured
- **SC-006**: All alert text content (including special characters, emoji, multi-line text) is accurately delivered to WhatsApp
- **SC-007**: Custom preview title "Trading View Alert" appears correctly in WhatsApp message preview for 100% of messages
- **SC-008**: Configuration validation on startup correctly identifies missing WhatsApp credentials and logs appropriate warnings

## Assumptions

- **Green API account and credentials**: User has an active Green API account with valid `waInstance`, `apiKey`, and `chatId` values
- **Character encoding**: Alert text uses UTF-8 encoding, which Green API supports natively
- **Message preview behavior**: WhatsApp's native behavior will display the `customPreview.title` field as documented in Green API
- **Backward compatibility**: Existing deployments without WhatsApp configuration will continue to work unchanged
- **Alert content**: Alert text content is appropriate for WhatsApp (no binary data, reasonable length <4096 chars for preview)
- **Multi-channel atomicity**: If one channel fails, others proceed independently (eventual consistency model, not transaction-based)

## Constraints

- **Green API Rate Limits**: GreenAPI sendMessage endpoint enforces 50 RPS limit. System implements per-message exponential backoff (max 3 retries with 1s → 2s → 4s delays) without global rate limit coordination.
- **Message Length**: Alert message body truncated to 20,000 characters to respect GreenAPI JSON payload limits; preview title validation deferred to GreenAPI.
- **Character Encoding**: Alert text uses UTF-8 encoding, which Green API supports natively
- **Alert Format**: Removing MarkdownV2 formatting for WhatsApp requires plain text conversion; complex formatted alerts may lose styling
- **Chat ID Format**: WhatsApp chat ID format must match Green API requirements (e.g., `120363xxxxx@g.us` for groups)
- **Backward Compatibility**: System must not break existing Telegram-only deployments that don't configure WhatsApp
