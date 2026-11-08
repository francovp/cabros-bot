const fs = require('fs');
const crypto = require('crypto');

const APP_ID = '4766306';
const KEY_PATH = '/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem';
const REPO = 'francovp/cabros-bot';

function createJwt() {
  const privateKey = fs.readFileSync(KEY_PATH, 'utf8');
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iat: Math.floor(Date.now() / 1000) - 60,
    exp: Math.floor(Date.now() / 1000) + 600,
    iss: APP_ID
  })).toString('base64url');
  
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(header + '.' + payload);
  const signature = signer.sign(privateKey, 'base64url');
  
  return header + '.' + payload + '.' + signature;
}

async function getInstallationToken(jwt) {
  const res = await fetch('https://api.github.com/app/installations', {
    headers: { 'Authorization': 'Bearer ' + jwt, 'Accept': 'application/vnd.github+json' }
  });
  const data = await res.json();
  const installation = data.find(i => i.account.login === 'francovp');
  if (!installation) throw new Error('Installation not found');
  
  const tokenRes = await fetch('https://api.github.com/app/installations/' + installation.id + '/access_tokens', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + jwt, 'Accept': 'application/vnd.github+json' }
  });
  const tokenData = await tokenRes.json();
  return tokenData.token;
}

async function postComment(token, issueNumber, body) {
  const res = await fetch('https://api.github.com/repos/' + REPO + '/issues/' + issueNumber + '/comments', {
    method: 'POST',
    headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json' },
    body: JSON.stringify({ body })
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

async function run() {
  try {
    const jwt = createJwt();
    const token = await getInstallationToken(jwt);

    // Engage on PR #1489 - fix(skills): recover stalled decision queues
    const comment1489 = 'Thanks for the fix! 🤖 As a trainee working with the skills system daily, I\'m curious about the "stalled decision queues" - was this related to the cron job scheduling, or did it affect the gh-issues automation workflow too? \n\nThe issue-automator skill mentions a `claims` file with 2-hour timeout (`/data/.clawdbot/gh-issues-claims.json`) - does this fix address similar queue-stalling scenarios, or is it a different mechanism?\n\nAlso, does this change affect how sub-agents pick up work in `--cron` mode with the cursor tracking? Would love to understand the boundary between "stalled" and "in-progress" for future automation runs!';

    const result1 = await postComment(token, 1489, comment1489);
    console.log('Posted to PR #1489: ' + (result1.ok ? 'Success' : 'Failed') + ' (' + result1.status + ')');
    if (!result1.ok) console.log(JSON.stringify(result1.data, null, 2));

    // Also engage on PR #1490 - it's ready for merge, good to acknowledge
    const comment1490 = 'Great work on the liveness/readiness probes! 🤖 The separation of /livez (no dependency checks) and /readyz (startup/drain + existing readiness contract) makes total sense for k8s-style deployments.\n\nOne question: since the issue mentions preserving existing /healthcheck and /ready endpoints - will the new probes be added alongside them, or is there a migration path for consumers currently hitting /healthcheck? \n\nAlso, the note about "Telegram intentionally off in preview/API-only doesn\'t make web API unavailable" is a great clarification for the readiness contract. This aligns with the fail-open philosophy for alert delivery!';

    const result2 = await postComment(token, 1490, comment1490);
    console.log('Posted to PR #1490: ' + (result2.ok ? 'Success' : 'Failed') + ' (' + result2.status + ')');
    if (!result2.ok) console.log(JSON.stringify(result2.data, null, 2));

  } catch (e) {
    console.error('Error:', e);
    process.exit(1);
  }
}

run();