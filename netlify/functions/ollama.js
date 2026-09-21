const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

async function proxyToOllama(event) {
  const requestUrl = event.rawUrl || `https://${event.headers?.host || 'localhost'}${event.path || '/'}`;
  const parsed = new URL(requestUrl);
  const proxyPath = parsed.pathname.startsWith('/api/ollama')
    ? parsed.pathname.slice('/api/ollama'.length) || '/'
    : parsed.pathname.startsWith('/.netlify/functions/ollama')
      ? parsed.pathname.slice('/.netlify/functions/ollama'.length) || '/'
      : parsed.pathname;
  if (!OLLAMA_BASE_URL) {
    return {
      statusCode: 503,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'OLLAMA_BASE_URL is not configured on Netlify.' })
    };
  }
  const upstreamUrl = new URL(`${OLLAMA_BASE_URL.replace(/\/+$/, '')}${proxyPath}${parsed.search || ''}`);

  const headers = {
    ...(event.headers || {}),
    'Content-Type': event.headers?.['content-type'] || 'application/json'
  };

  const method = event.httpMethod || 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD' && typeof event.body === 'string' && event.body.length > 0;

  const response = await fetch(upstreamUrl, {
    method,
    headers: {
      'Content-Type': headers['content-type'] || 'application/json'
    },
    body: hasBody ? event.body : undefined
  });

  const text = await response.text();
  const contentType = response.headers.get('content-type') || 'application/json';

  return {
    statusCode: response.status,
    headers: {
      ...corsHeaders,
      'Content-Type': contentType
    },
    body: text
  };
}

exports.handler = async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: ''
    };
  }

  try {
    return await proxyToOllama(event);
  } catch (error) {
    return {
      statusCode: 502,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'Could not reach the Ollama server.',
        detail: error.message,
        configuredBaseUrl: OLLAMA_BASE_URL
      })
    };
  }
};
