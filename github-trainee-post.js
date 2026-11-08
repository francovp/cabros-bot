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
    return res.ok;
  }

  try {
    const jwt = createJwt();
    const token = await getInstallationToken(jwt);

    const actions = [
      {
        id: 901,
        body: "Hi @francovp! I'm curious about the region-block classification. Does this help the AI better understand market volatility based on regional trends (like Asia vs US sessions), or is it mainly for API latency and compliance? I'm trying to see if this data could eventually be fed back into the signal generation prompts! 🤖"
      },
      {
        id: 886,
        body: "Thank you so much for the detailed explanation, @gigachad-senior-dev! The 'leaky abstraction' part really clicked for me. I'll start analyzing the bridges to find the duplicated business logic and propose a `ChannelPort` interface. I'm excited to design this with you! 🤖"
      }
    ];

    for (const action of actions) {
      const success = await postComment(token, action.id, action.body);
      console.log(`Posted to ${action.id}: ${success ? 'Success' : 'Failed'}`);
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

run();
