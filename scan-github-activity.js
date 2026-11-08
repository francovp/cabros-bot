const fs = require('fs');
const crypto = require('crypto');

const APP_ID = '4766306';
const KEY_PATH = '/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem';
const REPO = 'francovp/cabros-bot';
const LAST_SCAN = '2026-11-04T17:45:00.000Z';

function createJwt() {
  const privateKey = fs.readFileSync(KEY_PATH, 'utf8');
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iat: Math.floor(Date.now() / 1000) - 60,
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

async function fetchWithPagination(url, token) {
  const results = [];
  let nextUrl = url;
  while (nextUrl) {
    const res = await fetch(nextUrl, {
      headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json' }
    });
    const data = await res.json();
    results.push(...data);
    const link = res.headers.get('link');
    nextUrl = null;
    if (link) {
      const match = link.match(/<([^>]+)>;\s*rel="next"/);
      if (match) nextUrl = match[1];
    }
  }
  return results;
}

async function scanActivity() {
  const jwt = createJwt();
  const token = await getInstallationToken(jwt);
  
  console.log('Scanning GitHub activity since:', LAST_SCAN);
  
  // Fetch issues updated since last scan
  const issues = await fetchWithPagination(
    `https://api.github.com/repos/${REPO}/issues?state=all&since=${LAST_SCAN}&per_page=100`,
    token
  );
  
  // Fetch PRs updated since last scan
  const prs = await fetchWithPagination(
    `https://api.github.com/repos/${REPO}/pulls?state=all&since=${LAST_SCAN}&per_page=100`,
    token
  );
  
  // Fetch comments on issues/PRs since last scan
  const issueComments = await fetchWithPagination(
    `https://api.github.com/repos/${REPO}/issues/comments?since=${LAST_SCAN}&per_page=100`,
    token
  );
  
  const prComments = await fetchWithPagination(
    `https://api.github.com/repos/${REPO}/pulls/comments?since=${LAST_SCAN}&per_page=100`,
    token
  );
  
  // Filter for comments from @francovp or @gigachad-senior-dev that might be corrections
  const targetUsers = ['francovp', 'gigachad-senior-dev'];
  const correctionComments = [];
  
  [...issueComments, ...prComments].forEach(comment => {
    if (targetUsers.includes(comment.user.login)) {
      // Check if this looks like a correction/negative feedback
      const body = comment.body.toLowerCase();
      const correctionKeywords = [
        'correction', 'negative', 'incorrect', 'wrong', 'fix this', 'not correct',
        'revision needed', 'p1', 'blocker', 'cannot merge', 'prevent merge',
        'automation/skip', 'automation readiness', 'score:', '/100',
        'needs user', 'needs_user', 'not ready', 'out of scope',
        'disagree', 'no', 'incorrect', 'mistake', 'error in'
      ];
      
      const isCorrection = correctionKeywords.some(kw => body.includes(kw));
      
      if (isCorrection) {
        correctionComments.push({
          user: comment.user.login,
          body: comment.body,
          url: comment.html_url,
          created_at: comment.created_at,
          issue_url: comment.issue_url
        });
      }
    }
  });
  
  console.log('\n=== SCAN RESULTS ===');
  console.log(`Issues updated: ${issues.length}`);
  console.log(`PRs updated: ${prs.length}`);
  console.log(`Issue comments: ${issueComments.length}`);
  console.log(`PR comments: ${prComments.length}`);
  console.log(`Correction comments found: ${correctionComments.length}`);
  
  if (correctionComments.length > 0) {
    console.log('\n=== CORRECTION COMMENTS ===');
    correctionComments.forEach(c => {
      console.log(`\nUser: @${c.user}`);
      console.log(`Time: ${c.created_at}`);
      console.log(`URL: ${c.url}`);
      console.log(`Body: ${c.body.substring(0, 500)}...`);
    });
  }
  
  // Also check for new issues/PRs that might need Virgin Trainee engagement
  const newIssues = issues.filter(i => !i.pull_request && new Date(i.created_at) > new Date(LAST_SCAN));
  const newPrs = prs.filter(p => new Date(p.created_at) > new Date(LAST_SCAN));
  
  console.log(`\nNew issues since last scan: ${newIssues.length}`);
  console.log(`New PRs since last scan: ${newPrs.length}`);
  
  newIssues.forEach(i => {
    console.log(`  #${i.number}: ${i.title} (${i.html_url})`);
  });
  
  newPrs.forEach(p => {
    console.log(`  #${p.number}: ${p.title} (${p.html_url})`);
  });
  
  return {
    scanTime: new Date().toISOString(),
    lastRun: LAST_SCAN,
    issues: issues.length,
    prs: prs.length,
    issueComments: issueComments.length,
    prComments: prComments.length,
    correctionComments,
    newIssues: newIssues.map(i => ({ number: i.number, title: i.title, url: i.html_url })),
    newPrs: newPrs.map(p => ({ number: p.number, title: p.title, url: p.html_url }))
  };
}

scanActivity().then(result => {
  fs.writeFileSync('/home/ubuntu/.openclaw/workspace/github_activity_scan.json', JSON.stringify(result, null, 2));
  console.log('\nScan results saved to github_activity_scan.json');
}).catch(err => {
  console.error('Scan failed:', err);
  process.exit(1);
});