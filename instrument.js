const sentryService = require('./src/services/monitoring/SentryService');

// Initialize monitoring service first (must be before other imports that might throw)
sentryService.init();