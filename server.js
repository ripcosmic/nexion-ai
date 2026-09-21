const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const auth = require('./auth');

const SESSION_COOKIE = 'nexion_session';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || '';
}

function sessionCookie(token, maxAgeSeconds = 2592000) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (IS_PRODUCTION || process.env.NEXION_SECURE_COOKIES === 'true') parts.push('Secure');
  return parts.join('; ');
}

const HOST = '0.0.0.0';
const PORT = process.env.PORT || 4173;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const ROOT = process.cwd();
console.log('ROOT_DIR', ROOT);
console.log('INDEX_EXISTS', fs.existsSync(path.join(ROOT, 'index.html')));

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(text);
}

function requestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (error) { reject(new Error('Request body must be valid JSON.')); }
    });
    req.on('error', reject);
  });
}

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || '').split(';').map(value => value.trim());
  const entry = cookies.find(value => value.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}

async function handleAuth(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    try {
      const body = await requestBody(req);
      auth.register({ email: body.email, password: body.password, name: body.name });
      const login = auth.login({
        email: body.email,
        password: body.password,
        ip: clientIp(req),
        userAgent: req.headers['user-agent']
      });
      res.writeHead(201, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': sessionCookie(login.sessionToken)
      });
      res.end(JSON.stringify({ user: login.user }));
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    try {
      const body = await requestBody(req);
      const result = auth.login({
        email: body.email,
        password: body.password,
        ip: clientIp(req),
        userAgent: req.headers['user-agent']
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': sessionCookie(result.sessionToken)
      });
      res.end(JSON.stringify({ user: result.user }));
    } catch (error) {
      sendJson(res, 401, { error: error.message });
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/request') {
    try {
      const body = await requestBody(req);
      await auth.requestLogin(body.email);
      sendJson(res, 202, { message: 'If the address is valid, a sign-in link has been sent.' });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/verify') {
    try {
      const sessionToken = auth.verifyLogin(url.searchParams.get('token'));
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': sessionCookie(sessionToken)
      });
      res.end();
    } catch (error) {
      sendText(res, 400, error.message);
    }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    sendJson(res, 200, { user: auth.session(cookieValue(req, SESSION_COOKIE)) });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    auth.clearSession(cookieValue(req, SESSION_COOKIE));
    res.writeHead(204, { 'Set-Cookie': sessionCookie('', 0) });
    res.end();
    return true;
  }
  return false;
}

function serveStaticFile(res, filePath) {
  try {
    const fullPath = path.resolve(filePath);
    const ext = path.extname(fullPath).toLowerCase();
    const buffer = fs.readFileSync(fullPath);

    const contentType = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    }[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*'
    });
    res.end(buffer);
  } catch (error) {
    console.error('READ_FILE_ERROR', filePath, error.message);
    sendText(res, 404, 'Not found');
  }
}

function proxyToOllama(req, res, urlPath) {
  const targetUrl = new URL(urlPath, OLLAMA_URL);
  const method = req.method || 'GET';

  const bodyChunks = [];
  req.on('data', chunk => bodyChunks.push(chunk));
  req.on('end', async () => {
    const body = bodyChunks.length ? Buffer.concat(bodyChunks) : undefined;

    try {
      const upstream = await fetch(targetUrl, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(req.headers.accept ? { Accept: req.headers.accept } : {})
        },
        body
      });

      const responseText = await upstream.text();
      const responseHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8'
      };
      res.writeHead(upstream.status, responseHeaders);
      res.end(responseText);
    } catch (error) {
      sendJson(res, 502, {
        error: 'Ollama proxy failed',
        detail: error.message,
        targetUrl: targetUrl.toString()
      });
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  handleAuth(req, res, url).catch(error => sendJson(res, 500, { error: error.message }));
  if (url.pathname.startsWith('/api/auth/')) return;

  if (url.pathname.startsWith('/api/ollama')) {
    const targetPath = url.pathname.replace(/^\/api\/ollama/, '') || '/';
    const targetUrl = `${targetPath}${url.search}`;
    proxyToOllama(req, res, targetUrl);
    return;
  }

  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = filePath.replace(/^\//, '');
  const absPath = path.join(ROOT, filePath);
  console.log('REQ', { pathname: url.pathname, filePath, absPath, exists: fs.existsSync(absPath), isFile: fs.existsSync(absPath) ? fs.statSync(absPath).isFile() : false });

  if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
    serveStaticFile(res, absPath);
    return;
  }

  sendText(res, 404, 'Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Nexion backend running on http://${HOST}:${PORT}`);
  console.log(`Ollama proxy target: ${OLLAMA_URL}`);
});
