// src/lib/envValidator.js
// Validate required environment variables at startup

function validateEnv() {
  const requiredVars = ['BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  const missingVars = [];

  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      missingVars.push(varName);
    }
  }

  if (missingVars.length > 0) {
    console.error('\x1b[31mError: Missing required environment variables:\x1b[0m');
    missingVars.forEach(varName => {
      console.error(`  - ${varName}`);
    });
    console.error('\nPlease set these variables in your .env file.');
    process.exit(1);
  }

  // Additional validation for BOT_TOKEN (should not be empty)
  if (process.env.BOT_TOKEN.trim() === '') {
    console.error('\x1b[31mError: BOT_TOKEN cannot be empty\x1b[0m');
    process.exit(1);
  }

  // Additional validation for TELEGRAM_CHAT_ID (should be a number or string that looks like a chat ID)
  const chatId = process.env.TELEGRAM_CHAT_ID.trim();
  if (chatId === '') {
    console.error('\x1b[31mError: TELEGRAM_CHAT_ID cannot be empty\x1b[0m');
    process.exit(1);
  }

  // Optional: Validate that TELEGRAM_CHAT_ID is a valid format (starts with - for groups or is a number)
  // Telegram chat IDs can be negative numbers (for groups/supergroups) or positive numbers (for users)
  // We'll do a basic check: either a number (possibly negative) or a string that matches the pattern for supergroups
  if (!/^-?\d+$/.test(chatId) && !chatId.endsWith('@g.us')) {
    console.warn('\x1b[33mWarning: TELEGRAM_CHAT_ID format may be invalid. Expected a number (e.g., -1001234567890) or a supergroup ID (e.g., 120363xxxxx@g.us)\x1b[0m');
  }

  console.log('\x1b[32m✓ Environment variables validated successfully\x1b[0m');
}

module.exports = { validateEnv };