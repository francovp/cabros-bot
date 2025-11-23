# Feature Specification: Enrich Alert Output

**Feature Branch**: `004-enrich-alert-output`  
**Created**: 22 de noviembre de 2025  
**Status**: Draft  
**Input**: User description: "I need to improve the output of the /api/webhook/alert endpoint request with more enrich content."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Receive Enriched Alert with Structured Insights (Priority: P1)

As a trader, I want to receive alerts that include sentiment, key insights, and technical levels so that I can make better decisions without leaving the chat.

**Why this priority**: This is the core value proposition of the feature—transforming plain text alerts into actionable financial intelligence.

**Independent Test**: Can be tested by sending a sample alert (e.g., "BTC broke 83k") to the webhook and verifying the received message contains the new structured sections.

**Acceptance Scenarios**:

1. **Given** a valid alert about a crypto price movement, **When** the webhook processes it, **Then** the delivered message includes a "Sentiment" section (e.g., 🔴 Bearish).
2. **Given** a valid alert, **When** processed, **Then** the message includes a "Key Insights" section with bullet points summarizing the event.
3. **Given** a valid alert, **When** processed, **Then** the message includes a "Technical Levels" section if support/resistance levels are mentioned or inferred.
4. **Given** a valid alert, **When** processed, **Then** the message includes a "Sources" section with links to verified news.

---

### User Story 2 - Graceful Fallback for Analysis Failure (Priority: P2)

As a system administrator, I want the system to deliver a standard summary if the structured analysis fails, so that no alerts are lost due to AI parsing errors.

**Why this priority**: Ensures reliability. The AI model might occasionally fail to return valid JSON, and we cannot afford to drop alerts.

**Independent Test**: Can be tested by mocking the AI response to return invalid JSON or an error, and verifying that a basic alert is still delivered.

**Acceptance Scenarios**:

1. **Given** the AI model returns malformed JSON, **When** the system processes the response, **Then** it falls back to using the plain text summary.
2. **Given** the AI model times out, **When** the system processes the alert, **Then** it delivers the original alert text (existing behavior preserved).

### Edge Cases

- What happens when the alert text is too short to generate insights? (System should return "Neutral" sentiment and minimal insights).
- How does the system handle alerts in languages other than English? (System should attempt to preserve the language in the structured output).
- What happens if no sources are found? (System should still generate insights based on the alert text itself, but mark sources as empty).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST analyze the alert text and extract structured data including:
  - **Sentiment**: Classification (Bullish, Bearish, Neutral) and a score/confidence.
  - **Key Insights**: A list of 1-3 bullet points summarizing the most important facts.
  - **Technical Levels**: Identification of support and resistance levels if present in the context.
- **FR-002**: System MUST format the enriched alert for **Telegram** using the platform's supported rich text formatting, displaying the new fields clearly (e.g., using emojis for sentiment).
- **FR-003**: System MUST format the enriched alert for **WhatsApp** using the platform's supported rich text formatting, displaying the new fields clearly.
- **FR-004**: System MUST fallback to the original plain text summary (or original text) if the structured analysis fails.
- **FR-005**: System MUST include citations/sources in the enriched output, formatted as links (Telegram) or text (WhatsApp).
- **FR-006**: System MUST use the existing Grounding Service infrastructure to perform this analysis.

### Key Entities *(include if feature involves data)*

- **EnrichedAlert**: Represents the processed alert data.
  - `original_text`: The raw alert.
  - `sentiment`: Enum (BULLISH, BEARISH, NEUTRAL).
  - `insights`: List of strings.
  - `technical_levels`: Object `{ supports: string[], resistances: string[] }`.
  - `sources`: List of citations (title, url).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 95% of alerts successfully include structured sentiment and insights (measured by presence of fields in logs/output).
- **SC-002**: Alerts are delivered to both Telegram and WhatsApp with correct formatting (verified by visual inspection or integration tests checking for markdown syntax errors).
- **SC-003**: Fallback mechanism triggers successfully in 100% of analysis failure cases (verified by chaos testing/mocking).
- **SC-004**: Latency for alert processing does not increase by more than 2 seconds compared to the current implementation.
