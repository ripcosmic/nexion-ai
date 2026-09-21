const fs = require('fs');
const path = require('path');
require('dotenv').config();

const ROOT = path.resolve(__dirname, '..');
const inputDirectory = path.resolve(process.env.OPENROUTER_INPUT_DIR || path.join(ROOT, 'training'));
const outputFile = path.resolve(process.env.OPENROUTER_OUTPUT || path.join(ROOT, 'training', 'openrouter-augmented.jsonl'));
const checkpointFile = `${outputFile}.checkpoint.json`;
const apiKey = process.env.OPENROUTER_API_KEY;
const model = process.env.OPENROUTER_MODEL || 'openrouter/free';
const variantsPerSeed = Math.min(Math.max(Number(process.env.OPENROUTER_VARIANTS || 2), 1), 10);
const maxExamples = Math.max(Number(process.env.OPENROUTER_MAX_EXAMPLES || 500), 1);

function readSeeds() {
  const files = fs.readdirSync(inputDirectory)
    .filter(file => file.endsWith('.jsonl') && file !== path.basename(outputFile))
    .sort();
  const rows = [];
  for (const file of files) {
    const source = path.join(inputDirectory, file);
    for (const [index, line] of fs.readFileSync(source, 'utf8').split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSON in ${source}:${index + 1}: ${error.message}`);
      }
      if (typeof row.prompt === 'string' && typeof row.response === 'string') {
        rows.push({ prompt: row.prompt.trim(), response: row.response.trim() });
      }
    }
  }
  return rows;
}

function uniqueRows(rows) {
  const seen = new Set();
  return rows.filter(row => {
    const key = `${row.prompt}\u0000${row.response}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseResponse(content) {
  const parsed = JSON.parse(content);
  const examples = Array.isArray(parsed) ? parsed : parsed.examples;
  if (!Array.isArray(examples)) throw new Error('OpenRouter response did not contain an examples array.');
  return examples
    .filter(row => row && typeof row.prompt === 'string' && typeof row.response === 'string')
    .map(row => ({ prompt: row.prompt.trim(), response: row.response.trim() }))
    .filter(row => row.prompt && row.response);
}

async function generate(seed) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.APP_URL || 'http://localhost:4173',
      'X-Title': 'Nexion training-data generator'
    },
    body: JSON.stringify({
      model,
      temperature: 0.45,
      max_tokens: 1800,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You create high-quality instruction-tuning examples for Nexion. Return only JSON with an examples array. Each item must have prompt and response strings. Preserve facts, do not invent credentials, and make responses practical, clear, and safe.'
        },
        {
          role: 'user',
          content: `Create ${variantsPerSeed} meaningfully different training examples based on this seed. Improve clarity, vary wording, and keep the answer technically correct.\n\nSeed prompt: ${seed.prompt}\nSeed response: ${seed.response}`
        }
      ]
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${payload.error?.message || 'request failed'}`);
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('OpenRouter returned no message content.');
  return parseResponse(content);
}

async function main() {
  if (!apiKey) throw new Error('Set OPENROUTER_API_KEY in .env. Never put the key in source code or chat.');
  const seeds = readSeeds();
  if (!seeds.length) throw new Error(`No prompt/response JSONL rows found in ${inputDirectory}.`);

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const checkpoint = fs.existsSync(checkpointFile)
    ? JSON.parse(fs.readFileSync(checkpointFile, 'utf8'))
    : { nextSeed: 0, rows: [] };
  const rows = uniqueRows(checkpoint.rows || []);

  for (let index = checkpoint.nextSeed || 0; index < seeds.length && rows.length < maxExamples; index += 1) {
    const generated = await generate(seeds[index]);
    rows.push(...generated);
    const bounded = uniqueRows(rows).slice(0, maxExamples);
    fs.writeFileSync(checkpointFile, JSON.stringify({ nextSeed: index + 1, rows: bounded }, null, 2));
    console.log(JSON.stringify({ seed: index + 1, totalSeeds: seeds.length, examples: bounded.length }));
  }

  const finalRows = uniqueRows(rows).slice(0, maxExamples);
  fs.writeFileSync(outputFile, finalRows.map(row => JSON.stringify(row)).join('\n') + (finalRows.length ? '\n' : ''), 'utf8');
  console.log(JSON.stringify({ output: outputFile, examples: finalRows.length, model, note: 'Generated data is ready for local training; OpenRouter weights were not modified.' }));
}

main().catch(error => {
  console.error(`OPENROUTER_DATASET_ERROR: ${error.message}`);
  process.exitCode = 1;
});
