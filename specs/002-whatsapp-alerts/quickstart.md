# Quickstart: Multi-Channel Alerts (WhatsApp & Telegram)

**Branch**: `002-whatsapp-alerts` | **Date**: 2025-10-29  
**Objective**: Get WhatsApp + Telegram alert delivery running locally and in production

---

## Prerequisites

- Node.js 20.x
- Telegram bot token (existing setup)
- GreenAPI account with WhatsApp instance
- Active Telegram chat ID for alerts
- Active WhatsApp chat ID for alerts

---

## Step 1: GreenAPI Setup

1. **Create GreenAPI account** at https://green-api.com/en/my/sign-in
2. **Create WhatsApp instance** in GreenAPI console
3. **Note your instance details**:
   - Instance ID: `7107` (example from docs)
   - API Key: `your-api-key-here`
   - Save: `WHATSAPP_API_URL` = `https://7107.api.green-api.com/waInstance7107/sendMessage/`
   - Save: `WHATSAPP_API_KEY` = `your-api-key-here`
4. **Verify WhatsApp connection** in GreenAPI dashboard (scan QR code with WhatsApp)
5. **Get your chat ID**:
   - For **groups**: Right-click group → Info → Copy link (extract ID from URL)
   - Format: `120363xxxxx@g.us` (group ID with @g.us suffix)
   - For **personal chats**: Format: `5521987654321@c.us`

---

## Step 2: Environment Configuration

Update `.env` (or set in deployment):

```bash
# Existing Telegram config
BOT_TOKEN=1234567890:ABCdefGHIjklmnopqrstuvwxyz
TELEGRAM_CHAT_ID=-1001234567890
TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID=-1001234567890
ENABLE_TELEGRAM_BOT=true

# New WhatsApp config
ENABLE_WHATSAPP_ALERTS=true
WHATSAPP_API_URL=https://7107.api.green-api.com/waInstance7107/sendMessage/
WHATSAPP_API_KEY=your-api-key-here
WHATSAPP_CHAT_ID=120363xxxxx@g.us

# Optional grounding enrichment
ENABLE_GROUNDING=true
```

---

## Step 3: Install & Run

```bash
# Install dependencies (no new packages for native fetch)
npm install

# Start development server (with auto-reload)
npm run start-dev

# In another terminal, run tests (optional)
npm test

# Expected output:
#   ✓ WhatsApp service initialized
#   ✓ Telegram service initialized
#   ✓ Notification manager ready with 2 channels
#   Express server listening on port 3000
```

---

## Step 4: Test the Webhook

### Local Test (via curl)

```bash
curl -X POST http://localhost:3000/api/webhook/alert \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Test alert: BTC/USDT Price alert 🚀",
    "metadata": {
      "source": "TradingView",
      "webhookId": "test_001"
    }
  }'
```

**Expected Response** (200 OK):
```json
{
  "success": true,
  "message": "Alert received. Delivery in progress.",
  "results": [
    {
      "channel": "telegram",
      "success": true,
      "messageId": "123456789"
    },
    {
      "channel": "whatsapp",
      "success": true,
      "messageId": "true_120363xxxxx_BAE..."
    }
  ]
}
```

### Verify Delivery

- **Telegram**: Check your `TELEGRAM_CHAT_ID` for the alert message
- **WhatsApp**: Check your `WHATSAPP_CHAT_ID` for the alert message

Both should receive:
```
Test alert: BTC/USDT Price alert 🚀
```

---

## Step 5: Test Failure Scenarios

### Disable WhatsApp Temporarily

```bash
ENABLE_WHATSAPP_ALERTS=false npm run start-dev
```

Send alert again:
- **Result**: Message appears only in Telegram, not WhatsApp
- **Logs**: WhatsApp channel marked disabled, Telegram sends normally

### Test Retry Logic

Set an invalid `WHATSAPP_API_KEY` in env:
```bash
WHATSAPP_API_KEY=invalid-key npm run start-dev
```

Send alert:
- **Result**: 200 OK to webhook caller (fail-open)
- **Logs**: 3 retry attempts logged, admin notified in Telegram
- **WhatsApp**: No message (all retries failed)

### Test Truncation

Send a very long alert (>20K chars):
```bash
curl -X POST http://localhost:3000/api/webhook/alert \
  -H "Content-Type: application/json" \
  -d '{
    "text": "'$(python3 -c 'print("A" * 25000)')'"
  }'
```

**Result**:
- Text truncated to 20,000 chars + "…"
- Both channels receive truncated version
- Logs show: "Message truncated from 25000 to 20000 chars"

---

## Step 6: Monitor Logs

Watch for key log entries:

**Success Path**:
```
[2025-10-29T10:00:00.000Z] INFO: Alert webhook received (webhookId=test_001)
[2025-10-29T10:00:00.050Z] INFO: Grounding enrichment: 1 request, 45ms
[2025-10-29T10:00:00.100Z] INFO: NotificationManager: Sending to 2 channels
[2025-10-29T10:00:01.250Z] INFO: Telegram send: success (messageId=123456789, attempts=1)
[2025-10-29T10:00:01.500Z] INFO: WhatsApp send: success (messageId=true_120363xxxxx_BAE..., attempts=1)
```

**Failure Path**:
```
[2025-10-29T10:00:00.000Z] INFO: Alert webhook received
[2025-10-29T10:00:01.500Z] WARN: WhatsApp Retry 1/3: Request timeout. Retrying in 1.2s
[2025-10-29T10:00:02.700Z] WARN: WhatsApp Retry 2/3: HTTP 429 (rate limit). Retrying in 2.1s
[2025-10-29T10:00:05.000Z] ERROR: WhatsApp exhausted (3 retries). Admin notified.
[2025-10-29T10:00:05.200Z] INFO: Telegram send: success (messageId=987654321)
[2025-10-29T10:00:05.300Z] WARN: Admin notification sent to Telegram (1 delivery failed)
```

---

## Step 7: Deploy to Production (Render)

1. **Add environment variables** in Render dashboard:
   ```
   ENABLE_WHATSAPP_ALERTS=true
   WHATSAPP_API_URL=https://7107.api.green-api.com/waInstance7107/sendMessage/
   WHATSAPP_API_KEY=your-prod-api-key
   WHATSAPP_CHAT_ID=your-prod-chat-id
   ```

2. **Deploy** (push to branch):
   ```bash
   git push origin 002-whatsapp-alerts
   ```

3. **Verify health**:
   ```bash
   curl https://cabros-bot.render.com/healthcheck
   # Expected: { "status": "UP" }
   ```

4. **Send test alert** from production webhook caller (e.g., TradingView)

---

## Troubleshooting

### WhatsApp messages not arriving

**Check**:
1. `ENABLE_WHATSAPP_ALERTS=true` in env
2. GreenAPI instance online in dashboard
3. `WHATSAPP_CHAT_ID` format correct (includes `@g.us` or `@c.us` suffix)
4. Logs for "WhatsApp exhausted" or "connection timeout"

**Fix**:
- Verify GreenAPI account is active (paid or trial)
- Re-authenticate WhatsApp instance (scan QR code again)
- Check chat ID in GreenAPI console

### Telegram but not WhatsApp (or vice versa)

**Expected**: One channel working doesn't mean the other is broken. Test each independently:
```bash
# Disable WhatsApp
ENABLE_WHATSAPP_ALERTS=false npm run start-dev
# Send alert → should appear in Telegram only

# Disable Telegram
ENABLE_TELEGRAM_BOT=false npm run start-dev
# Send alert → should appear in WhatsApp only
```

### Admin notifications not appearing

**Check**:
1. `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` is set and different from regular alert chat
2. Telegram service is enabled
3. At least one channel actually failed (not just both succeeding)

**Debug**:
- Check logs for "Admin notification sent"
- Verify admin chat ID in Telegram (right-click chat → Info → copy ID)

---

## Configuration Checklist

- [ ] GreenAPI account created and WhatsApp instance added
- [ ] WhatsApp instance authenticated (QR code scanned)
- [ ] `WHATSAPP_API_URL` set correctly
- [ ] `WHATSAPP_API_KEY` set correctly
- [ ] `WHATSAPP_CHAT_ID` set with correct format (`@g.us` or `@c.us`)
- [ ] `ENABLE_WHATSAPP_ALERTS=true` in env
- [ ] Existing Telegram config verified
- [ ] Local test passes (both channels deliver)
- [ ] Logs reviewed for retry attempts or errors
- [ ] Production env vars set in Render
- [ ] Production deployment verified

---

## Next Steps

After quickstart:
1. **Review**: Check `/specs/002-whatsapp-alerts/data-model.md` for entity details
2. **Integrate**: Wire up services in main alert handler (`src/controllers/webhooks/handlers/alert/alert.js`)
3. **Test**: Run unit tests for formatters and retry logic (`tests/unit/whatsapp-*.test.js`)
4. **Deploy**: Merge PR to main branch for production release

---

## API Reference

See `contracts/alert-webhook.openapi.yml` for full OpenAPI specification.

### Endpoint
- **POST** `/api/webhook/alert` — Submit alert for delivery

### Request Body
```json
{
  "text": "Alert message (required, max 20K chars)",
  "metadata": {
    "source": "TradingView (optional)",
    "webhookId": "tv_alert_123 (optional)"
  }
}
```

### Response (200 OK)
```json
{
  "success": true,
  "message": "Alert received. Delivery in progress.",
  "results": [
    {
      "channel": "telegram",
      "success": true,
      "messageId": "..."
    },
    {
      "channel": "whatsapp",
      "success": true,
      "messageId": "..."
    }
  ]
}
```

---

## Support

For issues or questions:
1. Check logs: `npm run start-dev` shows real-time debug output
2. Review plan: `specs/002-whatsapp-alerts/plan.md`
3. Review research: `specs/002-whatsapp-alerts/research.md`
4. Check data model: `specs/002-whatsapp-alerts/data-model.md`
