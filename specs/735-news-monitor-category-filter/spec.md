# Specification: Event Category Filtering for News Monitor (Issue #735)

## Overview
Adds an optional `categories` filter to the news-monitor endpoint (`POST /api/news-monitor` and `GET /api/news-monitor`) allowing API callers and operators to selectively monitor specific alertable event categories (`price_surge`, `price_decline`, `public_figure`, `regulatory`).

## Problem Statement
The news-monitor endpoint analyzes symbols and detects all supported event categories without filtering. Operators cannot selectively monitor specific event categories — for example, a trader interested only in `regulatory` announcements or `public_figure` remarks must receive (and pay for/deliver) `price_surge` and `price_decline` alerts as well.

## Scope & Architectural Alignment
1. **Request Interface**:
   - `POST /api/news-monitor`: Accepts optional `categories: string[]` in JSON body.
   - `GET /api/news-monitor`: Accepts optional `categories=cat1,cat2` comma-separated query string (or repeated/array form).
   - Omitted: Processes all categories (100% backward compatible).
2. **Validation (HTTP 400)**:
   - Allowed alertable categories: `price_surge`, `price_decline`, `public_figure`, `regulatory`.
   - Rejects empty arrays, non-string items, `'none'`, or unknown category strings with HTTP 400 `INVALID_REQUEST`.
   - Normalizes category inputs: trimmed and lowercase.
3. **Post-Classification Delivery Filtering**:
   - Gemini prompt and execution remain untouched (post-Gemini filtering).
   - When Gemini classifies a symbol's event into a category not present in the requested filter, alert delivery is suppressed:
     - No notification is dispatched to Telegram, WhatsApp, or Discord.
     - `result.alert` is `null` in the response.
     - `result.deliveryResults` is empty (`[]`).
     - `summary.alerts_sent` does not count it.
     - It does not consume volume-throttled delivery capacity.
4. **Cache & Deduplication Invariant**:
   - The dedup cache key remains `(symbol, eventCategory)`. The request filter is never added to the cache key, avoiding cache key splitting or cross-filter pollution.
   - A detected event is cached under its true event category so subsequent requests do not re-trigger duplicate analyses.
   - On cached reads: if a cached alert belongs to a category excluded by the caller's `categories` filter, the cached alert is not delivered (`status: 'cached', alert: null, deliveryResults: []`).
5. **Contract Updates**:
   - `src/openapi/openapi.json`: Document `categories` parameter on `GET` and `POST /api/news-monitor`.
   - `CabrosBot.postman_collection.json`: Add category-filtered request variants.
