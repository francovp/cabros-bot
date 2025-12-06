require('dotenv').config();
const { enrichAlert } = require('./grounding');
const { validateAlert } = require('../../../../lib/validation');
const MarkdownV2Formatter = require('../../../../services/notification/formatters/markdownV2Formatter');
const TelegramService = require('../../../../services/notification/TelegramService');
const WhatsAppService = require('../../../../services/notification/WhatsAppService');
const NotificationManager = require('../../../../services/notification/NotificationManager');
const { getURLShortener } = require('../../handlers/newsMonitor/urlShortener');
const sentryService = require('../../../../services/monitoring/SentryService');

// Initialize services
let notificationManager = null;

/**
 * Initialize notification services
 * Call this once on app startup
 * @param {Object} bot - Telegraf bot instance
 * @returns {Promise<NotificationManager>}
 */
async function initializeNotificationServices(bot) {
  const telegramService = new TelegramService({
    bot,
    logger: console,
  });

  const whatsappService = new WhatsAppService({
    logger: console,
    urlShortener: getURLShortener(),
  });

  notificationManager = new NotificationManager(telegramService, whatsappService);
  
  console.debug('Initializing notification services...');
  await notificationManager.validateAll();
  
  const enabledChannels = notificationManager.getEnabledChannels();
  console.debug(`Notification services initialized: ${enabledChannels.join(', ')}`);
  
  return notificationManager;
}

/**
 * Get the initialized NotificationManager instance
 * Used by other handlers (e.g., newsMonitor) to send alerts
 * @returns {NotificationManager|null}
 */
function getNotificationManager() {
  return notificationManager;
}

function postAlert(bot) {
  return async (req, res) => {
    const { body } = req;
    // Declare at top of try scope so they're accessible in catch
    let alertText = '';
    let alert = null;
    let enriched = false;

    try {
      // Parse and validate alert text
      if (typeof body === 'object' && 'text' in body) {
        alertText = body.text;
      } else {
        alertText = body;
      }

      const { text } = validateAlert(alertText);

      let messageText;
      alert = { text };

      // Only attempt grounding if enabled (check env at runtime so tests can toggle)
      if (process.env.ENABLE_GEMINI_GROUNDING === 'true') {
        try {
          console.debug('Starting grounding process');

          const enrichedAlert = await enrichAlert({ text });
          enriched = true;
          alert.enriched = enrichedAlert;
          console.debug('[Alert] Grounding completed, citations:', (enrichedAlert.citations && enrichedAlert.citations.length) || 0);
        } catch (error) {
          console.warn('[Alert] Grounding failed, using original text:', error.message);
        }
      }

      // Send to all enabled notification channels
      const results = await notificationManager.sendToAll(alert);

      // Return 200 OK regardless of delivery success (fail-open pattern)
      res.json({ success: true, results, enriched });
    } catch (error) {
      console.error('[Alert] Request failed:', error.message);

      // Capture runtime error to Sentry (T012)
      sentryService.captureRuntimeError({
        channel: 'http-alert',
        error,
        http: {
          endpoint: '/api/webhook/alert',
          method: 'POST',
          statusCode: (error.response && error.response.error_code) || 500,
        },
        alert: {
          textLength: alertText ? alertText.length : 0,
          hasEnrichment: !!(alert && alert.enriched),
          enrichedSource: alert && alert.enriched ? 'gemini-grounding' : undefined,
          truncated: false,
        },
      });

      const status = (error.response && error.response.error_code) || 500;
      const errorResponse = error.response || { error: 'Internal server error', details: error.message };
      res.status(status).send(errorResponse);
    }
  };
}

module.exports = {
  postAlert,
  initializeNotificationServices,
  getNotificationManager,
};
