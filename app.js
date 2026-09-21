const $ = (selector) => document.querySelector(selector);
const historyEl = $('#history');
const conversation = $('#conversation');
const messageInput = $('#message');
let chats = [];
let learnedExamples = [];
let currentUser = null;
let storageNamespace = 'guest';
let activeChat = null;
let recognition;
let rebuildTimer;
let localBrain = null;
let activeMode = localStorage.getItem('nexion-mode') || 'normal';
let attachedFile = null;
let onlineSources = localStorage.getItem('nexion-online-sources') !== 'false' && localStorage.getItem('jarvis-online-sources') !== 'false';
let voiceEnabled = localStorage.getItem('nexion-voice-enabled') !== 'false' && localStorage.getItem('jarvis-voice-enabled') !== 'false';
let modelProvider = localStorage.getItem('nexion-model-provider') || localStorage.getItem('jarvis-model-provider') || 'local';
const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
const defaultOllamaUrl = isLocalhost
  ? (window.location.port !== '4173' ? 'http://127.0.0.1:4173/api/ollama' : '/api/ollama')
  : '/.netlify/functions/ollama';
const savedOllamaUrl = localStorage.getItem('nexion-ollama-url') || localStorage.getItem('jarvis-ollama-url');
function normalizeOllamaUrl(value) {
  const candidate = String(value || '').trim().replace(/\/+$/, '');
  if (!candidate) return defaultOllamaUrl;
  if (isLocalhost && /^https?:\/\/(127\.0\.0\.1|localhost):11434$/i.test(candidate)) return defaultOllamaUrl;
  if (candidate === '/api/ollama' || candidate.endsWith('/api/ollama')) return candidate;
  return candidate.replace(/\/api\/?$/, '');
}
let ollamaUrl = savedOllamaUrl ? normalizeOllamaUrl(savedOllamaUrl) : defaultOllamaUrl;
if (isLocalhost && window.location.port !== '4173' && (ollamaUrl === '/api/ollama' || ollamaUrl.endsWith('/api/ollama'))) {
  ollamaUrl = defaultOllamaUrl;
}
if (savedOllamaUrl !== ollamaUrl) localStorage.setItem('nexion-ollama-url', ollamaUrl);
let ollamaBaseModel = localStorage.getItem('nexion-ollama-base-model') || localStorage.getItem('jarvis-ollama-base-model') || 'llama3.2:1b';
let ollamaModel = localStorage.getItem('nexion-ollama-model') || 'nexion-safe';
if (ollamaModel === 'jarvis-ai' || ollamaModel === 'nexion-ai') ollamaModel = 'nexion-safe';

const NEXION_SYSTEM = 'You are Nexion, a warm, capable local AI assistant with a purple-coded identity. '
  + 'For explanatory questions, use a helpful emoji in the main heading, provide a definition only when the user asks what something means or asks for a definition, then give a detailed explanation, structured bullet or numbered lists, examples when useful, and finish with an "In short" summary. '
  + 'For simple greetings such as hello or hi, reply naturally and briefly; do not define the greeting unless the user explicitly asks for its definition. '
  + 'Use Markdown headings with #, bold important terms with **bold**, and keep the answer substantial and easy to scan. '
  + 'When the user wants code, return complete, runnable examples in fenced markdown code blocks with a language tag, explain the code before or after it, and include a short usage example. '
  + 'Do not claim to know everything. Distinguish facts from guesses.';
const CODE_LANGUAGE_GUIDE = 'Coding coverage includes Python, JavaScript, TypeScript, JSX/React, Node.js, HTML, CSS, SQL, Bash, PowerShell, Java, Kotlin, C, C++, C#, Go, Rust, Swift, Dart/Flutter, PHP, Ruby, R, Lua, Perl, Scala, Haskell, Elixir, Solidity, MATLAB, GraphQL, YAML, JSON, XML, Dockerfiles, and regular expressions. Adapt syntax, standard libraries, package managers, formatting, error handling, security practices, and testing conventions to the requested language.';

// Keep local fallback replies varied even when a prompt is outside the trained examples.
const LOCAL_RESPONSE_STARTS = [
  'That is a thoughtful question. ',
  'Here is a practical way to look at it: ',
  'I can help with that. ',
  'A useful starting point is this: ',
  'Let us break it down together. ',
  'Good question — the short version is: ',
  'I would approach it in small, clear steps: ',
  'Here is the key idea: ',
  'Thanks for asking. My best local answer is: ',
  'A simple rule of thumb is: ',
  'That sounds worth exploring. ',
  'Here is a concise explanation: ',
  'You can make progress by starting here: ',
  'The most important detail is this: ',
  'I see what you are aiming for. ',
  'A calm, reliable approach would be: ',
  'Let us turn that into an actionable next step: ',
  'My local knowledge suggests this: ',
  'Here is a helpful perspective: ',
  'I would keep it simple: '
];
const LOCAL_RESPONSE_BODIES = [
  'define the goal first, then choose the smallest step that gives you useful feedback.',
  'write down what you already know, identify the missing detail, and test one assumption at a time.',
  'start with a small working version before adding polish or complexity.',
  'compare the available options by reliability, effort, and how easy they are to change later.',
  'make the next action specific enough that you can finish it in one focused session.',
  'use clear names, simple boundaries, and a quick check to confirm the result.',
  'separate facts from guesses so the decision stays easy to review.',
  'try the simplest explanation first, then add detail only where it helps.',
  'keep a small note of what worked; that turns each attempt into reusable knowledge.',
  'pause when the result looks surprising and verify the input before changing the whole approach.',
  'break a large task into visible milestones and celebrate each completed piece.',
  'prefer a solution that is understandable and dependable over one that is merely clever.'
];
const LOCAL_RESPONSE_ENDINGS = [
  'You have got this! ✨',
  'One step at a time. 🚀',
  'That is a solid place to begin. 🌱',
  'Small progress still counts. 💜',
  'Keep experimenting and stay curious. 🔍',
  'I am here if you want to explore it further. 🤝',
  'Clarity comes from trying. 💡',
  'Let us make it work together. 🛠️',
  'Nice and steady wins here. 🌟',
  'You can refine it as you learn. 🔄',
  'A little momentum goes a long way. ⚡',
  'Hope that gives you a useful direction! 😊'
];
const LOCAL_RESPONSE_POOL = LOCAL_RESPONSE_STARTS.flatMap((start, startIndex) =>
  LOCAL_RESPONSE_BODIES.map((body, bodyIndex) =>
    `${start}${body} ${LOCAL_RESPONSE_ENDINGS[(startIndex + bodyIndex) % LOCAL_RESPONSE_ENDINGS.length]}`
  )
);

function renderHistory() {
  const rows = chats;
  const groups = rows.reduce((all, chat) => ((all[chat.date || 'Today'] ||= []).push(chat), all), {});
  historyEl.innerHTML = Object.entries(groups).map(([date, items]) => `<section class="history-group"><div class="history-date">${date}</div>${items.map((chat) => `<button class="chat-item ${chat.id === activeChat?.id ? 'active' : ''}" data-id="${chat.id || ''}"><span class="chat-symbol">▣</span><span class="chat-title">${escapeHtml(chat.title)}</span><small class="chat-time">${chat.time || ''}</small></button>`).join('')}</section>`).join('');
  historyEl.querySelectorAll('[data-id]').forEach(button => button.onclick = () => openChat(button.dataset.id));
}
function welcome() {
  conversation.innerHTML = `<div class="welcome"><div class="nexion-orb"></div><h1>Hello, I’m Nexion.<br>How can I help you today?</h1><p>I answer questions and write code from my trained knowledge.<br>Turn on { } for code mode when you want examples.<br>What would you like to do?</p></div>`;
}
function formatMessage(content) {
  const fence = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0;
  let html = '';
  let match;
  while ((match = fence.exec(content))) {
    html += formatInline(content.slice(last, match.index));
    html += `<pre class="code-block"><div class="code-head"><span>${escapeHtml(match[1] || 'code')}</span><span class="code-actions"><button type="button" class="copy-code">Copy</button><button type="button" class="save-code">Save</button></span></div><code>${escapeHtml(match[2].replace(/\n$/, ''))}</code></pre>`;
    last = match.index + match[0].length;
  }
  html += formatInline(content.slice(last));
  return html;
}
function formatInline(text) {
  const lines = escapeHtml(text).split('\n');
  let listType = null;
  const html = [];
  const closeList = () => {
    if (listType) { html.push(`</${listType}>`); listType = null; }
  };
  lines.forEach(line => {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const orderedItem = line.match(/^\s*\d+\.\s+(.+)$/);
    const unorderedItem = line.match(/^\s*[-*]\s+(.+)$/);
    const formatted = (heading ? heading[2] : orderedItem ? orderedItem[1] : unorderedItem ? unorderedItem[1] : line)
      .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g, '<strong>$1</strong>');
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 6);
      html.push(`<h${level}>${formatted}</h${level}>`);
    } else if (orderedItem || unorderedItem) {
      const nextType = orderedItem ? 'ol' : 'ul';
      if (listType !== nextType) { closeList(); html.push(`<${nextType}>`); listType = nextType; }
      html.push(`<li>${formatted}</li>`);
    } else {
      closeList();
      html.push(formatted, '<br>');
    }
  });
  closeList();
  return html.join('').replace(/(?:<br>)+$/, '');
}
function formatSources(sources = []) {
  if (!sources.length) return '';
  const uniqueSources = sources.filter((source, index, all) => /^https?:\/\//i.test(source.url || '') && all.findIndex(item => item.url === source.url) === index);
  if (!uniqueSources.length) return '';
  return `<details class="message-sources"><summary>Check sources</summary><ol>${uniqueSources.slice(0, 5).map(source =>
    `<li><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title || source.url)}</a><span>${escapeHtml(source.url)}</span></li>`
  ).join('')}</ol></details>`;
}
function formatImages(images = []) {
  if (!images.length) return '';
  return `<section class="message-images" aria-label="Related images"><div class="message-images-title">Related images</div><div class="message-images-grid">${images.slice(0, 4).map(image =>
    `<a href="${escapeHtml(image.sourceUrl || image.url)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.title || 'Related image')}" loading="lazy"><span>${escapeHtml(image.title || 'View source')}</span></a>`
  ).join('')}</div></section>`;
}
function renderChat() {
  if (!activeChat || !activeChat.messages.length) return welcome();
  conversation.innerHTML = activeChat.messages.map(m => `<article class="message-row ${m.role} ${m.content === 'Nexion is responding…' ? 'pending' : ''} ${m.typing ? 'typing' : ''}"><span class="message-label">${m.role === 'user' ? 'YOU' : 'NEXION'}</span>${formatMessage(m.content)}${m.role === 'assistant' ? formatImages(m.images) + formatSources(m.sources) : ''}</article>`).join('');
  conversation.querySelectorAll('.copy-code').forEach(button => {
    button.onclick = () => {
      const code = button.closest('.code-block')?.querySelector('code')?.textContent || '';
      navigator.clipboard.writeText(code).then(() => {
        button.textContent = 'Copied';
        setTimeout(() => button.textContent = 'Copy', 1200);
      });
      conversation.querySelectorAll('.save-code').forEach(button => {
        button.onclick = () => {
          const block = button.closest('.code-block');
          const code = block?.querySelector('code')?.textContent || '';
          const language = block?.querySelector('.code-head span')?.textContent || 'txt';
          const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
          const link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = `nexion-fixed-code.${language === 'javascript' ? 'js' : language}`;
          link.click();
          URL.revokeObjectURL(link.href);
        };
      });
    };
  });
  conversation.scrollTop = conversation.scrollHeight;
}
function openChat(id) { activeChat = chats.find(c => c.id === id); renderHistory(); renderChat(); }
function newChat() { activeChat = { id: crypto.randomUUID(), date: 'Today', title: 'New conversation', time: 'Now', messages: [] }; chats.unshift(activeChat); persist(); renderHistory(); welcome(); messageInput.focus(); }
function storageKey(name) { return `nexion-${name}:${storageNamespace}`; }
function loadAccountData() {
  chats = JSON.parse(localStorage.getItem(storageKey('chats')) || '[]');
  learnedExamples = JSON.parse(localStorage.getItem(storageKey('learned-examples')) || '[]');
  activeChat = null;
}
function persist() { localStorage.setItem(storageKey('chats'), JSON.stringify(chats)); }
function persistLearning() {
  localStorage.setItem(storageKey('learned-examples'), JSON.stringify(learnedExamples));
  updateLearningStatus();
}
function updateLearningStatus() {
  const status = $('#ollama-status');
  if (status && !status.textContent.includes('Ollama is')) {
    status.textContent = `Persistent local examples: ${learnedExamples.length}`;
  }
}
function rememberExample(prompt, response) {
  learnedExamples.push({ prompt, response });
  persistLearning();
  if (modelProvider === 'ollama') {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => buildOllamaModel(), 1000);
  }
}
function escapeHtml(value) { const node = document.createElement('div'); node.textContent = value; return node.innerHTML; }
function looksLikeCodeRequest(prompt) {
  return isCodingMode() || /\b(code|function|script|python|javascript|html|css|sql|react|class|debug|snippet|example|fix)\b/i.test(prompt);
}
function fallbackResponse(prompt) {
  const hash = Array.from(String(prompt)).reduce((total, character) => (total * 31 + character.charCodeAt(0)) >>> 0, 7);
  return LOCAL_RESPONSE_POOL[hash % LOCAL_RESPONSE_POOL.length];
}
function expandLocalResponse(prompt, answer) {
  if (looksLikeCodeRequest(prompt) || /^#{1,6}\s/m.test(answer)) return answer;
  return `# 💡 Understanding your question\n\n${answer}\n\n## 📘 Definition\nIn this context, the idea is best understood as a practical way to reach the result you described. The exact meaning can depend on the subject, the goal, and the information available, so treat this as a useful starting explanation rather than an absolute rule.\n\n## 🔎 Detailed explanation\nStart by identifying the main goal and separating it from secondary details. Then break the problem into smaller parts, check the assumptions behind each part, and compare the result with what you expected. This makes the answer easier to understand, test, and improve instead of relying on one unverified conclusion.\n\n## 🧭 How to apply it\n1. Describe the desired outcome in one sentence.\n2. Gather the relevant facts and note anything uncertain.\n3. Try the smallest useful next step.\n4. Review the result and refine the approach based on evidence.\n\n## ⚠️ Important considerations\nThe best solution may change when the requirements, timeframe, or available tools change. If this involves health, law, money, safety, or current events, verify the details with a qualified and up-to-date source.\n\n## ✅ In short\nStart with the definition, follow the steps in order, and verify the result before relying on it.`;
}
function codingFallback(prompt) {
  return `# 💻 Coding request\n\nI can help build this, but the local retrieval brain does not contain a close enough implementation for this specific request.\n\n## 📘 What I need\nPlease include as many of these details as possible:\n\n- **Language and version** (for example, Python 3.13, Node.js 22, Java 21, or C# 12).\n- **Framework and dependencies** (for example, React, Django, .NET, Spring, or Flutter).\n- **Expected input and output**.\n- **Current code or error message**, if you are fixing an existing project.\n- **Runtime constraints**, such as browser, Windows, Linux, mobile, database, or API requirements.\n\n## 🧭 Best way to get a complete implementation\nSelect **Coding** mode, attach the relevant files, and ask for the feature or fix. If Ollama is configured, Nexion can use the local language model for open-ended generation; the retrieval brain is intentionally conservative and will not invent a large implementation it cannot verify.\n\n## ✅ In short\nThis request needs a language, requirements, or source files before a reliable solution can be generated.`;
}
async function loadLocalBrain() {
  const response = await fetch(`./models/nexion-brain.json?updated=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error('The local Nexion Brain file is missing. Run: python brain.py train');
  localBrain = await response.json();
  $('#connection-status').textContent = `Nexion Brain local — ${localBrain.examples.length} trained examples`;
}
function wantsWebSearch(prompt) {
  return activeMode === 'web' || /\b(search|search the web|look(?: it)? up|find online|browse|latest|today(?:'s)?|current|news|price|weather|recent|what happened)\b/i.test(prompt);
}
function isCodingMode() { return activeMode === 'coding'; }
function isThinkingMode() { return activeMode === 'thinking'; }
function modeInstructions() {
  if (isCodingMode()) return `CODING MODE: Act as a senior software engineer and polyglot coding specialist. ${CODE_LANGUAGE_GUIDE} Inspect supplied files carefully, identify the language and intent, explain bugs and risks, then return a corrected complete version in a fenced code block. Preserve working behavior, make surgical fixes, and include a concise change summary and how to run or test it. Before finalizing, self-review syntax, types, imports, edge cases, error handling, security, performance, and compatibility. If a requirement is impossible, contradictory, unsafe, or missing required information, say so clearly and provide the closest valid alternative instead of inventing an answer.`;
  if (isThinkingMode()) return 'THINKING MODE: Work through mathematics, science, subjects, and difficult reasoning carefully. Define terms, state assumptions, show the reasoning step by step, verify calculations, compare alternatives, and end with a clear conclusion. Do not reveal hidden chain-of-thought; provide a useful concise reasoning summary instead.';
  if (activeMode === 'web') return 'WEB SEARCH MODE: Perform a deep web search, synthesize multiple sources, explain the topic in detail, distinguish facts from uncertainty, and provide a source-backed summary.';
  return 'NORMAL MODE: Give a clear, detailed, structured answer with definitions, examples, and an In short summary.';
}
async function searchWeb(prompt) {
  if (!onlineSources) throw new Error('Web search is disabled in Settings. Enable online reference sources and try again.');
  const query = String(prompt).replace(/^(please\s+)?(search|look\s+up|find|browse)\s+(the\s+)?(web|internet|online)?\s*(for\s+)?/i, '').trim() || prompt;
  const searchUrl = `https://api.duckduckgo.com/?${new URLSearchParams({ q: query, format: 'json', no_html: '1', skip_disambig: '1' })}`;
  const response = await fetch(searchUrl);
  let search = {};
  if (response.ok) {
    try {
      search = await response.json();
    } catch {
      // Fall through to Wikipedia when the search provider returns an invalid payload.
    }
  }
  const results = [];
  if (search.AbstractText) results.push({ title: search.Heading || query, text: search.AbstractText, url: search.AbstractURL });
  const related = (search.RelatedTopics || []).flatMap(topic => topic.Topics || topic).filter(topic => topic.Text && topic.FirstURL);
  related.slice(0, 5).forEach(topic => results.push({ title: topic.Text.split(' - ')[0], text: topic.Text, url: topic.FirstURL }));
  (search.Results || []).slice(0, 5).forEach(result => results.push({ title: result.Text, text: result.Text, url: result.FirstURL }));
  if (!results.length) {
    const wikiUrl = `https://en.wikipedia.org/w/api.php?${new URLSearchParams({ action: 'query', list: 'search', srsearch: query, srlimit: '3', format: 'json', origin: '*' })}`;
    const wikiResponse = await fetch(wikiUrl);
    if (wikiResponse.ok) {
      const wiki = await wikiResponse.json();
      wiki.query?.search?.forEach(item => results.push({
        title: item.title,
        text: item.snippet.replace(/<[^>]+>/g, ''),
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`
      }));
    }
  }
  if (!results.length) throw new Error(`No web results found for "${query}".`);
  const images = await searchImages(query);
  return { query, results, images };
}
async function searchImages(query) {
  const imageUrl = `https://commons.wikimedia.org/w/api.php?${new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: query, gsrnamespace: '6', gsrlimit: '4',
    prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '720', format: 'json', origin: '*'
  })}`;
  const response = await fetch(imageUrl);
  if (!response.ok) return [];
  let payload;
  try {
    payload = await response.json();
  } catch {
    return [];
  }
  return Object.values(payload.query?.pages || {}).map(page => {
    const info = page.imageinfo?.[0];
    return {
      title: page.title?.replace(/^File:/, '') || 'Related image',
      url: info?.thumburl || info?.url,
      sourceUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title || '')}`
    };
  }).filter(image => image.url);
}
function formatWebResults(search) {
  const main = search.results[0];
  const points = search.results.slice(0, 5).map(result => `- ${result.text}`).join('\n');
  return `# 🌐 ${search.query}\n\n## 📖 Definition and overview\n${main.text}\n\n## 🔎 What this means\nThe search results describe the main topic using information from the sources listed below. Read the details in context because definitions, prices, events, and recommendations can change over time. When the topic has several interpretations, compare the wording and publication date of each source before making an important decision.\n\n## 📌 Key points\n${points}\n\n## 🧭 Practical context\nUse the information above as a starting point, then open the main source for the complete definition, supporting evidence, dates, limitations, and related material. This answer is based on live search results and is not a substitute for professional advice where safety, health, legal, or financial decisions are involved.\n\n## ✅ In short\nUse the overview to understand the topic, review the key points, and open the main source for complete details.`;
}
async function findOnlineReference(prompt) {
  const search = await searchWeb(prompt);
  return formatWebResults(search);
}
async function responseFromOllama(messages) {
  let response;
  try {
    response = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ollamaModel, messages, stream: false, options: { temperature: 0.7, num_predict: 4096 } })
    });
  } catch (error) {
    throw new Error(`Could not reach Ollama at ${ollamaUrl}: ${error.message}`);
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Ollama could not run ${ollamaModel} (HTTP ${response.status}). ${detail || 'The model may be missing or unavailable.'}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`Ollama returned invalid JSON: ${error.message}`);
  }
  if (!payload.message?.content) throw new Error('Ollama returned no assistant response.');
  return payload.message.content;
}
function ensureEmojiResponse(text) {
  const content = String(text || '').trim();
  if (!content) throw new Error('Ollama returned an empty assistant response.');
  if (/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(content)) return content;
  return `# 💜 Nexion's response\n\n${content}`;
}
function isSimpleGreeting(prompt) {
  return /^(?:hello|hi|hey|good morning|good afternoon|good evening)(?:\s+nexion)?[!.?]*$/i.test(String(prompt).trim());
}
function isDefinitionRequest(prompt) {
  const value = String(prompt).trim();
  return /\b(?:what(?:\s+(?:is|does|are)|\s*['’]s)?\s+(?:the\s+)?(?:definition|meaning)\s+(?:of|for)|define\b|definition\s+of\b|meaning\s+of\b|what\s+does\s+.+\s+mean|what\s+is\s+.+\s+for\b|what\s+is\s+.+\s+mean\b)/i.test(value);
}
async function responseFor(prompt, messages = [{ role: 'user', content: prompt }], onProgress = () => {}) {
  if (isSimpleGreeting(prompt)) {
    onProgress('preparing a greeting…');
    return { text: 'Hi! I am Nexion. What would you like to work on?', sources: [] };
  }
  const shouldSearch = wantsWebSearch(prompt);
  onProgress('matching trained knowledge…');
  const webResults = shouldSearch ? await searchWeb(prompt) : null;
  if (modelProvider === 'ollama') {
    onProgress('asking Ollama…');
    let ollamaMessages = [{ role: 'system', content: NEXION_SYSTEM }, ...messages];
    ollamaMessages[0].content += `\n\n${modeInstructions()}`;
    if (isCodingMode()) ollamaMessages[0].content += `\n\n${CODE_LANGUAGE_GUIDE} Prefer complete implementations over pseudocode. For complex requests, provide architecture, files, dependencies, implementation, tests, and verification steps. Never claim code was executed unless execution evidence is available.`;
    if (webResults) ollamaMessages[0].content += `\n\nUse these live web search results to write a VERY detailed, custom answer. Start with an emoji-supported Markdown heading, then include sections titled Definition, Detailed explanation, Examples or key points, Important considerations, and In short. Provide at least 6 substantial paragraphs plus useful headings, bullet points, or numbered lists. Answer every part of the user's request, mention uncertainty or conflicting details, and do not invent facts. Do not put raw URLs in the answer; the interface will show them in a Check sources section. Use the available context rather than giving a short snippet.\n\n${formatWebResults(webResults)}`;
    else if (onlineSources) {
      try {
        onProgress('checking reference sources…');
        const reference = await findOnlineReference(prompt);
        if (reference) ollamaMessages[0].content += `\n\nUse this current reference when relevant. Do not claim it says more than it does.\n\n${reference}`;
      } catch { /* Ollama remains available without optional reference results. */ }
    }
    return { text: ensureEmojiResponse(await responseFromOllama(ollamaMessages)), sources: webResults?.results || [], images: webResults?.images || [] };
  }
  if (webResults) return { text: formatWebResults(webResults), sources: webResults.results, images: webResults.images };
  if (!localBrain) await loadLocalBrain();
  const searchPrompt = isCodingMode() || looksLikeCodeRequest(prompt) ? `${prompt} code example function script debug fix` : prompt;
  const stopwords = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'can', 'could', 'do', 'does', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'please', 'tell', 'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'would', 'you', 'your']);
  const words = (String(searchPrompt).toLowerCase().match(/[a-z0-9']{2,}/g) || []).filter(word => !stopwords.has(word));
  const counts = words.reduce((all, word) => ((all[word] = (all[word] || 0) + 1), all), {});
  const weighted = Object.fromEntries(Object.entries(counts).filter(([word]) => localBrain.vocabulary[word]).map(([word, count]) => [word, count * localBrain.vocabulary[word]]));
  const length = Math.sqrt(Object.values(weighted).reduce((sum, value) => sum + value * value, 0)) || 1;
  Object.keys(weighted).forEach(word => weighted[word] /= length);
  const scored = localBrain.examples.map(example => ({ example, score: Object.entries(weighted).reduce((sum, [word, weight]) => sum + weight * (example.vector[word] || 0), 0) }));
  const best = scored.reduce((result, item) => item.score > result.score ? item : result, { score: -1, example: null });
  const threshold = looksLikeCodeRequest(prompt) ? 0.08 : 0.13;
  if (best.score >= threshold) return { text: expandLocalResponse(prompt, best.example.response), sources: [] };
  if (isCodingMode() || looksLikeCodeRequest(prompt)) return { text: codingFallback(prompt), sources: [] };
  try {
    onProgress('checking reference sources…');
    const reference = await findOnlineReference(prompt);
    if (reference) return { text: reference, sources: [] };
  } catch { /* The local model still works when the network or source is unavailable. */ }
  return { text: expandLocalResponse(prompt, fallbackResponse(prompt)), sources: [] };
}
function speak(text) {
  if (!voiceEnabled || !$('#auto-speak').checked || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const spoken = text.replace(/```[\s\S]*?```/g, ' Code example. ');
  const utterance = new SpeechSynthesisUtterance(spoken); const voice = speechSynthesis.getVoices()[$('#voice-select').value];
  if (voice) utterance.voice = voice; utterance.rate = +$('#rate').value; utterance.pitch = +$('#pitch').value; speechSynthesis.speak(utterance);
}
function updateVoiceState() {
  const settings = $('#voice-settings');
  const button = $('#voice-button');
  $('#voice-enabled').checked = voiceEnabled;
  settings.toggleAttribute('aria-disabled', !voiceEnabled);
  settings.querySelectorAll('select, input, button').forEach(control => control.disabled = !voiceEnabled);
  $('#voice-help').textContent = voiceEnabled ? 'Voice input and spoken replies are enabled.' : 'Voice input and spoken replies are disabled.';
  button.disabled = !voiceEnabled;
  button.setAttribute('aria-pressed', String(voiceEnabled));
  button.title = voiceEnabled ? 'Speak to Nexion' : 'Voice features are disabled in Settings';
  if (!voiceEnabled) {
    if (recognition) recognition.stop();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }
}
function updateModelState() {
  return modelProvider;
}
function updateCodeMode() {
  const labels = { normal: 'Message Nexion...', coding: 'Describe code to write, read, or fix...', web: 'Ask for a deep web search...', thinking: 'Ask a difficult question...' };
  messageInput.placeholder = labels[activeMode] || labels.normal;
  ['code-mode', 'web-search', 'thinking-mode'].forEach(id => {
    const button = $(`#${id}`);
    const selected = (id === 'code-mode' && activeMode === 'coding') || (id === 'web-search' && activeMode === 'web') || (id === 'thinking-mode' && activeMode === 'thinking');
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  document.querySelectorAll('#mode-menu [data-mode]').forEach(button => button.classList.toggle('active', button.dataset.mode === activeMode));
}
async function checkOllama() {
  const status = $('#ollama-status');
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`);
    if (!response.ok) throw new Error('Ollama did not respond.');
    const payload = await response.json();
    const models = payload.models || [];
    const count = models.length;
    let available = models.some(model => model.name === ollamaModel || model.name === `${ollamaModel}:latest`);
    if (!available && ollamaModel !== 'nexion-safe') {
      ollamaModel = 'nexion-safe';
      localStorage.setItem('nexion-ollama-model', ollamaModel);
      updateModelState();
      available = models.some(model => model.name === 'nexion-safe' || model.name === 'nexion-safe:latest');
    }
    status.textContent = available || ollamaModel === 'nexion-safe'
      ? `Ollama is ready — ${count} local model${count === 1 ? '' : 's'} found. Using ${ollamaModel}.`
      : `Ollama is reachable, but ${ollamaModel} is not installed. Build it or choose an installed model.`;
    return models;
  } catch (error) {
    status.textContent = `Cannot reach Ollama at ${ollamaUrl}. Start Ollama and allow this site with OLLAMA_ORIGINS, then check again.`;
    return [];
  }
}
async function buildOllamaModel() {
  const button = $('#build-ollama');
  ollamaBaseModel = $('#ollama-base-model').value.trim() || 'llama3.2:1b';
  ollamaModel = $('#ollama-model').value.trim() || 'nexion-safe';
  localStorage.setItem('nexion-ollama-base-model', ollamaBaseModel);
  localStorage.setItem('nexion-ollama-model', ollamaModel);
  button.disabled = true;
  try {
    if (!localBrain) await loadLocalBrain();
    $('#ollama-status').textContent = `Downloading ${ollamaBaseModel} if needed…`;
    const pull = await fetch(`${ollamaUrl}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: ollamaBaseModel, stream: false }) });
    if (!pull.ok) throw new Error(await pull.text());
    const examples = [...localBrain.examples, ...learnedExamples];
    $('#ollama-status').textContent = `Building the 1B ${ollamaModel} model with Nexion behavior…`;
    const trainingContext = examples.map((example, index) =>
      `Example ${index + 1}:\nUser: ${example.prompt}\nNexion: ${example.response}`
    ).join('\n\n');
    const create = await fetch(`${ollamaUrl}/api/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel, from: ollamaBaseModel, stream: false,
        system: `${NEXION_SYSTEM} Follow Nexion style: use clear headings, definitions, detailed explanations, examples, practical steps, and an In short summary. Use your base-model knowledge when appropriate, distinguish facts from guesses, and say when you are uncertain. Never claim to know everything or invent an answer.\n\nProject training examples:\n${trainingContext}`,
        parameters: { temperature: 0.3, num_ctx: 16384 }
      })
    });
    if (!create.ok) throw new Error(await create.text());
    modelProvider = 'ollama';
    localStorage.setItem('nexion-model-provider', modelProvider);
    updateModelState();
    $('#ollama-status').textContent = `1B ${ollamaModel} is ready with Nexion behavior enabled from ${examples.length} local examples.`;
  } catch (error) {
    $('#ollama-status').textContent = `Could not build Nexion with Ollama: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}
function animateResponse(chat, message, reply, onComplete) {
  const characters = Array.from(reply.text);
  let position = 0;
  message.content = '';
  message.sources = reply.sources || [];
  message.images = reply.images || [];
  message.typing = true;
  const step = () => {
    if (activeChat !== chat || !chat.messages.includes(message)) return;
    position = Math.min(position + Math.max(1, Math.ceil(characters.length / 180)), characters.length);
    message.content = characters.slice(0, position).join('');
    renderChat();
    if (position < characters.length) {
      window.setTimeout(step, 8);
      return;
    }
    message.typing = false;
    onComplete();
  };
  step();
}
function sendMessage(text = messageInput.value.trim()) {
  if (!text) return; if (!activeChat) newChat();
  const chat = activeChat;
  const startedAt = new Date();
  const timing = $('#generation-timing');
  timing.textContent = `Prompt sent ${formatTime(startedAt)} • preparing…`;
  const attachmentContext = attachedFile ? `\n\nAttached file: ${attachedFile.name}\n\`\`\`${attachedFile.language}\n${attachedFile.content}\n\`\`\`` : '';
  const prompt = `${modeInstructions()}\n\n${text}${attachmentContext}`;
  chat.messages.push({ role: 'user', content: text }); chat.title = text.slice(0, 30); chat.time = 'Now'; messageInput.value = ''; resizeInput(); persist(); renderHistory(); renderChat();
  const messages = chat.messages.slice(0, -1).concat({ role: 'user', content: prompt }).map(({ role, content }) => ({ role, content }));
  const responseMessage = { role: 'assistant', content: 'Nexion is responding…' };
  chat.messages.push(responseMessage); renderChat();
  responseFor(prompt, messages, status => {
    timing.textContent = `Prompt sent ${formatTime(startedAt)} • ${status}`;
  }).then(reply => {
    const finishedAt = new Date();
    animateResponse(chat, responseMessage, reply, () => {
      rememberExample(prompt, reply.text);
      persist();
      speak(reply.text);
      timing.textContent = `Prompt sent ${formatTime(startedAt)} • generation done ${formatTime(finishedAt)} • ${formatDuration(finishedAt - startedAt)}`;
    });
  }).catch(error => {
    const finishedAt = new Date();
    responseMessage.content = `${modelProvider === 'ollama' ? 'Ollama' : 'Local model'} error: ${error.message}`;
    persist();
    renderChat();
    timing.textContent = `Prompt sent ${formatTime(startedAt)} • failed ${formatTime(finishedAt)}`;
  });
}
function formatTime(value) { return value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function formatDuration(milliseconds) { return `${(milliseconds / 1000).toFixed(1)}s`; }
function resizeInput() { messageInput.style.height = 'auto'; messageInput.style.height = `${Math.min(messageInput.scrollHeight, 110)}px`; }
function populateVoices() { const select = $('#voice-select'); const voices = speechSynthesis.getVoices(); select.innerHTML = voices.map((v, i) => `<option value="${i}">${v.name} (${v.lang})</option>`).join('') || '<option>No system voice available</option>'; }
function updateLoginButton() {
  const label = currentUser ? (currentUser.name || currentUser.email) : null;
  $('#login-button').textContent = currentUser ? `${label} · Log out` : 'Log in';
  $('#login-button').setAttribute('aria-label', currentUser ? `Log out ${currentUser.email}` : 'Log in');
}
function applySignedInUser(user) {
  currentUser = user;
  storageNamespace = currentUser?.email ? `user-${encodeURIComponent(currentUser.email)}` : 'guest';
  loadAccountData();
  updateLoginButton();
  renderHistory();
  welcome();
}
function showAuthTab(tab) {
  const isLogin = tab === 'login';
  $('#tab-login').classList.toggle('active', isLogin);
  $('#tab-register').classList.toggle('active', !isLogin);
  $('#tab-login').setAttribute('aria-selected', String(isLogin));
  $('#tab-register').setAttribute('aria-selected', String(!isLogin));
  $('#login-form').hidden = !isLogin;
  $('#register-form').hidden = isLogin;
  $('#login-title').textContent = isLogin ? 'Welcome back' : 'Create your Nexion account';
  $('#login-status').textContent = '';
  (isLogin ? $('#login-email') : $('#register-email')).focus();
}
async function submitAuth(url, body, button, pendingLabel) {
  const status = $('#login-status');
  const original = button.textContent;
  button.disabled = true;
  status.textContent = pendingLabel;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Something went wrong. Please try again.');
    applySignedInUser(payload.user);
    $('#login-modal').hidden = true;
    status.textContent = '';
    return true;
  } catch (error) {
    status.textContent = error.message;
    return false;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}
async function loadCurrentAccount() {
  try {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
    const payload = await response.json();
    currentUser = payload.user;
  } catch (error) {
    currentUser = null;
  }
  storageNamespace = currentUser?.email ? `user-${encodeURIComponent(currentUser.email)}` : 'guest';
  loadAccountData();
  updateLoginButton();
  renderHistory();
  renderChat();
}

$('#new-chat').onclick = newChat; $('#composer').onsubmit = e => { e.preventDefault(); sendMessage(); };
messageInput.oninput = resizeInput; messageInput.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } };
function showSettings() { $('#settings-modal').hidden = false; $('#online-sources').checked = onlineSources; updateVoiceState(); $('#connection-status').textContent = localBrain ? `Nexion Brain local — ${localBrain.examples.length} trained examples` : 'Loading local Nexion Brain…'; loadLocalBrain().catch(error => $('#connection-status').textContent = error.message); populateVoices(); }
$('#open-settings').onclick = $('#settings-button').onclick = showSettings;
$('#login-button').onclick = async () => {
  if (currentUser) {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    applySignedInUser(null);
    return;
  }
  showAuthTab('login');
  $('#login-modal').hidden = false;
  $('#login-email').focus();
};
$('#tab-login').onclick = () => showAuthTab('login');
$('#tab-register').onclick = () => showAuthTab('register');
$('#close-login').onclick = () => $('#login-modal').hidden = true;
$('#login-modal').onclick = event => { if (event.target === event.currentTarget) event.currentTarget.hidden = true; };
$('#login-form').onsubmit = async event => {
  event.preventDefault();
  await submitAuth('/api/auth/login', {
    email: $('#login-email').value,
    password: $('#login-password').value
  }, $('#login-submit'), 'Signing you in…');
};
$('#register-form').onsubmit = async event => {
  event.preventDefault();
  const password = $('#register-password').value;
  if (password !== $('#register-confirm').value) {
    $('#login-status').textContent = 'Those passwords do not match.';
    return;
  }
  const created = await submitAuth('/api/auth/register', {
    name: $('#register-name').value,
    email: $('#register-email').value,
    password
  }, $('#register-submit'), 'Creating your account…');
  if (created) $('#register-form').reset();
};
$('#close-settings').onclick = () => $('#settings-modal').hidden = true;
$('#settings-modal').onclick = e => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; };
['rate','pitch'].forEach(key => $(`#${key}`).oninput = e => $(`#${key}-value`).textContent = key === 'rate' ? `${e.target.value}×` : e.target.value);
$('#test-voice').onclick = () => { const checked = $('#auto-speak').checked; $('#auto-speak').checked = true; speak('Voice configuration complete. Nexion is ready.'); $('#auto-speak').checked = checked; };
$('#voice-enabled').onchange = event => { voiceEnabled = event.target.checked; localStorage.setItem('nexion-voice-enabled', String(voiceEnabled)); updateVoiceState(); };
$('#online-sources').onchange = event => { onlineSources = event.target.checked; localStorage.setItem('nexion-online-sources', String(onlineSources)); };
$('#theme-toggle').onchange = e => document.body.classList.toggle('light', !e.target.checked);
const openModeMenu = () => { $('#mode-menu').hidden = !$('#mode-menu').hidden; };
$('#code-mode').onclick = openModeMenu;
$('#web-search').onclick = openModeMenu;
$('#thinking-mode').onclick = openModeMenu;
$('#mode-menu').onclick = event => { if (event.target === event.currentTarget) event.currentTarget.hidden = true; };
$('#mode-menu').querySelectorAll('[data-mode]').forEach(button => button.onclick = () => {
  activeMode = button.dataset.mode;
  localStorage.setItem('nexion-mode', activeMode);
  $('#mode-menu').hidden = true;
  updateCodeMode();
});
$('#attach-file').onclick = () => $('#file-input').click();
$('#file-input').onchange = async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  const content = await file.text();
  const extension = file.name.split('.').pop()?.toLowerCase() || 'text';
  attachedFile = { name: file.name, content, language: extension };
  const preview = $('#attachment-preview');
  preview.hidden = false;
  preview.innerHTML = `<span>📎 ${escapeHtml(file.name)} (${Math.round(file.size / 1024)} KB)</span><button type="button" id="remove-attachment" aria-label="Remove attachment">×</button>`;
  $('#remove-attachment').onclick = () => {
    attachedFile = null;
    preview.hidden = true;
    $('#file-input').value = '';
  };
  if (extension.match(/^(js|jsx|ts|tsx|py|java|c|cpp|cs|go|rs|php|rb|html|css|json|sql|xml|yml|yaml)$/)) {
    activeMode = 'coding';
    localStorage.setItem('nexion-mode', activeMode);
    updateCodeMode();
  }
};
$('#voice-button').onclick = () => {
  if (!voiceEnabled) return;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return alert('Voice input is not supported in this browser. Try Chrome or Edge.');
  if (recognition) return recognition.stop(); recognition = new Recognition(); recognition.lang = navigator.language || 'en-US'; recognition.interimResults = true; $('#voice-button').classList.add('listening');
  recognition.onresult = e => { messageInput.value = Array.from(e.results).map(r => r[0].transcript).join(''); resizeInput(); };
  recognition.onend = () => { recognition = null; $('#voice-button').classList.remove('listening'); if (messageInput.value.trim()) sendMessage(); };
  recognition.start();
};
if ('speechSynthesis' in window) { populateVoices(); speechSynthesis.onvoiceschanged = populateVoices; }
loadAccountData();
renderHistory(); welcome();
loadCurrentAccount();
updateVoiceState();
updateModelState();
updateCodeMode();
loadLocalBrain().catch(() => {});
window.setInterval(() => loadLocalBrain().catch(() => {}), 30_000);
