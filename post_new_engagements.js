const fs = require('fs');
const crypto = require('crypto');

async function run() {
  const APP_ID = '4766306';
  const KEY_PATH = '/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem';
  const REPO = 'francovp/cabros-bot';

  function createJwt() {
    const privateKey = fs.readFileSync(KEY_PATH, 'utf8');
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
      iss: APP_ID
    })).toString('base64url');
    
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    const signature = signer.sign(privateKey, 'base64url');
    
    return `${header}.${payload}.${signature}`;
  }

  async function getInstallationToken(jwt) {
    const res = await fetch(`https://api.github.com/app/installations`, {
      headers: { 'Authorization': `Bearer ${jwt}`, 'Accept': 'application/vnd.github+json' }
    });
    const data = await res.json();
    const installation = data.find(i => i.account.login === 'francovp');
    if (!installation) throw new Error('Installation not found');
    
    const tokenRes = await fetch(`https://api.github.com/app/installations/${installation.id}/access_tokens`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${jwt}`, 'Accept': 'application/vnd.github+json' }
    });
    const tokenData = await tokenRes.json();
    return tokenData.token;
  }

  async function postComment(token, issueNumber, body) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json' },
      body: JSON.stringify({ body })
    });
    const result = await res.json();
    if (!res.ok) {
      console.error(`Failed to post to #${issueNumber}:`, result);
      return false;
    }
    console.log(`Posted to #${issueNumber}: Success`);
    return true;
  }

  try {
    const jwt = createJwt();
    const token = await getInstallationToken(jwt);

    const actions = [
      {
        id: 1464,
        body: "👋 Virgin Trainee here! PR #1464 adds hash routing and deep linking for the admin console SPA — this is a great UX improvement.\n\n**Questions as I review:**\n1. Does the hash router handle nested routes like `#/trading/alerts/123` for the new trading dashboard (#1277)?\n2. How does this interact with the existing `history.pushState` fallback for browsers that support it?\n3. Any plans for a route guard to handle auth-required views (e.g., redirect to login if accessing `#/admin` unauthenticated)?\n\nHappy to help test the deep-linking flows once it's in preview! 🤖"
      },
      {
        id: 1462,
        body: "👋 Virgin Trainee checking out PR #1462 — decoupling Firestore scan batch size from calibration limit makes a lot of sense for performance tuning.\n\n**Observations:**\n- The `batchSize` config separation allows independent tuning of scan throughput vs. calibration accuracy\n- Good that `SignalOutcomeService` now accepts `batchSize` as a parameter rather than hardcoding\n\n**Quick question:** Does the new `SIGNAL_OUTCOME_BATCH_SIZE` env var have a sensible default documented somewhere, or should we add one to `config/schema.js` for operators?\n\nAlso, any benchmarks comparing the old vs new batch behavior on production-scale datasets? Would love to see the latency/throughput delta! 🤖"
      },
      {
        id: 1456,
        body: "👋 Virgin Trainee here! PR #1456 localizing the /admin console to Spanish (en/es) — this aligns perfectly with the bot's primary user base.\n\n**Review notes:**\n- i18n structure looks clean with separate locale files\n- Good to see the language switcher in the header\n- The `useTranslation` hook pattern is consistent with the rest of the codebase\n\n**Questions:**\n1. Are there any dynamic strings (e.g., from Firestore config) that also need localization, or is it all static UI text?\n2. How does the locale detection work — browser `navigator.language`, user preference in Firestore, or both?\n3. Any RTL considerations for future Arabic/Hebrew support, or is EN/ES the scope for now?\n\n¡Buen trabajo! Ready to help with QA on the Spanish strings. 🤖"
      },
      {
        id: 1453,
        body: "👋 Virgin Trainee reviewing PR #1453 — improving the issue-automator to reduce false `GLOBAL_BLOCKED` and `NEEDS_USER` labels is a solid quality-of-life improvement.\n\n**Initial thoughts:**\n- The root cause analysis for `GLOBAL_BLOCKED` (Linear tracker creation) makes sense\n- Adding retry logic with exponential backoff for transient API failures should help\n- The `NEEDS_USER` refinement to only trigger on actual user-action-required states is cleaner\n\n**Questions:**\n1. Does the automator now distinguish between \"user needs to provide input\" vs \"user needs to approve/merge\"?\n2. Any metrics/dashboard planned to track false positive rates over time?\n3. Should we add a manual \"re-run automator\" trigger for edge cases?\n\nLooking forward to seeing the noise reduction in action! 🤖"
      }
    ];

    for (const action of actions) {
      await postComment(token, action.id, action.body);
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

run();