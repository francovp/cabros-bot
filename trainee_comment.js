const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

function base64url(obj) {
    const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
    return Buffer.from(str).toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

async function request(options, data = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    resolve({
                        status: res.statusCode,
                        data: body ? JSON.parse(body) : null
                    });
                } catch (e) {
                    resolve({ status: res.statusCode, data: body });
                }
            });
        });
        req.on('error', reject);
        if (data) req.write(JSON.stringify(data));
        req.end();
    });
}

async function run() {
    const appId = '4766306';
    const privateKeyPath = '/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem';
    const repo = 'francovp/cabros-bot';
    const prNumber = 899;
    const commentBody = "Hi @francovp! I'm still learning about caching patterns in AI orchestration. I noticed you're using a process-local short-TTL cache here to deduplicate TradingView MCP results. Since the bot might run in multiple instances or scale horizontally, would a process-local cache lead to inconsistent results across different instances? Or is the TTL short enough that it doesn't really matter? I'm curious why a distributed cache like Redis wasn't chosen for this specific use case! 🤖";

    if (!fs.existsSync(privateKeyPath)) {
        console.error('Private key not found at', privateKeyPath);
        process.exit(1);
    }
    const privateKey = fs.readFileSync(privateKeyPath, 'utf8');

    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + (10 * 60),
        iss: appId,
    };

    const tokenParts = base64url(header) + '.' + base64url(payload);
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(tokenParts);
    const signature = signer.sign(privateKey, 'base64url');
    const jwt = tokenParts + '.' + signature;

    try {
        const installRes = await request({
            hostname: 'api.github.com',
            path: '/app/installations',
            method: 'GET',
            headers: { 'Authorization': `Bearer ${jwt}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'cabros-bot-trainee' }
        });
        
        if (!installRes.data || installRes.data.length === 0) {
            console.error('No installations found for this app.');
            process.exit(1);
        }
        const installationId = installRes.data[0].id;

        const iatRes = await request({
            hostname: 'api.github.com',
            path: `/app/installations/${installationId}/access_tokens`,
            method: 'POST',
            headers: { 'Authorization': `Bearer ${jwt}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'cabros-bot-trainee' }
        });
        const iat = iatRes.data.token;

        const postRes = await request({
            hostname: 'api.github.com',
            path: `/repos/${repo}/issues/${prNumber}/comments`,
            method: 'POST',
            headers: { 
                'Authorization': `token ${iat}`, 
                'Accept': 'application/vnd.github+json', 
                'User-Agent': 'cabros-bot-trainee',
                'Content-Type': 'application/json' 
            }
        }, { body: commentBody });

        console.log('Comment posted successfully!', postRes.status);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

run();
