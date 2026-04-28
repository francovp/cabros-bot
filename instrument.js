const { configureLogging } = require('./src/lib/logging');
const sentryService = require('./src/services/monitoring/SentryService');

// Initialize logging and monitoring services before other imports that might throw
configureLogging();
sentryService.init();