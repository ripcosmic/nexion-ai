#!/usr/bin/env node

/*
 * Import trusted, licensed source data into bounded JSONL shards.
 *
 * Supported inputs:
 * - JSONL: one object per line
 * - JSON: an array of objects, or {data: [...]}
 * - CSV: prompt,response columns (question/answer and instruction/output also work)
 * - Markdown/text: optional document chunks with --include-documents
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SOURCE = path.join(ROOT, 'sources');
const DEFAULT_OUTPUT = path.join(ROOT, 'training', 'source-import');

function usage() {
  console.log(`Usage:
  node scripts/import-source-dataset.js --source <file-or-directory> [options]

Options:
  --output <directory>       Output directory (default: training/source-import)
  --max-records <number>    Maximum records to write (default: 500000)
  --shard-size <number>     Records per JSONL shard (default: 10000)
  --include-documents       Import .md/.txt files as source-grounded chunks
  --chunk-characters <n>    Document chunk size (default: 4000)
  --license <name>          License label applied when a row has none
  --source-name <name>      Source label applied when a row has none
  --help                    Show this help
`);
}

function parseArgs(argv) {
  const options = {
    source: null,
    output: DEFAULT_OUTPUT,
    maxRecords: 500000,
    shardSize: 10000,
    includeDocuments: false,
    chunkCharacters: 4000,
    license: 'unspecified',
    sourceName: 'local-source',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      usage();
      process.exit(0);
    }
    if (arg === '--include-documents') {
      options.includeDocuments = true;
      continue;
    }
    const values = {
      '--source': 'source',
      '--output': 'output',
      '--max-records': 'maxRecords',
      '--shard-size': 'shardSize',
      '--chunk-characters': 'chunkCharacters',
      '--license': 'license',
      '--source-name': 'sourceName',
    };
    const key = values[arg];
    if (!key || i + 1 >= argv.length) {
      throw new Error(`Unknown or incomplete option: ${arg}`);
    }
    options[key] = argv[++i];
  }
  if (!options.source) throw new Error('--source is required.');
  for (const key of ['maxRecords', 'shardSize', 'chunkCharacters']) {
    options[key] = Number(options[key]);
    if (!Number.isInteger(options[key]) || options[key] < 1) {
      throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be a positive integer.`);
    }
  }
  return options;
}

function filesFor(source, includeDocuments) {
  const stat = fs.statSync(source);
  if (stat.isFile()) return [source];
  const files = [];
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const full = path.join(source, entry.name);
    if (entry.isDirectory()) files.push(...filesFor(full, includeDocuments));
    else if (/\.(jsonl?|csv)$/i.test(entry.name)
      || (includeDocuments && /\.(md|txt)$/i.test(entry.name))) files.push(full);
  }
  return files.sort();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') { cell += '"'; i += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === ',' && !quoted) { row.push(cell); cell = ''; continue; }
    if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      continue;
    }
    cell += char;
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows.shift().map((value) => value.trim().toLowerCase());
  return rows.map((values) => Object.fromEntries(headers.map((header, i) => [header, values[i] || ''])));
}

function readRows(file, includeDocuments, chunkCharacters) {
  const extension = path.extname(file).toLowerCase();
  const text = fs.readFileSync(file, 'utf8');
  if (extension === '.jsonl') {
    return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try { return JSON.parse(line); } catch (error) {
        throw new Error(`Invalid JSONL in ${file}:${index + 1}: ${error.message}`);
      }
    });
  }
  if (extension === '.json') {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : (Array.isArray(parsed.data) ? parsed.data : [parsed]);
  }
  if (extension === '.csv') return parseCsv(text);
  if (includeDocuments) {
    const chunks = text.match(new RegExp(`[\\s\\S]{1,${chunkCharacters}}`, 'g')) || [];
    return chunks.map((chunk, index) => ({
      prompt: `Explain the following source document section (${path.basename(file)}, part ${index + 1}).`,
      response: chunk.trim(),
      source: file,
    })).filter((row) => row.response);
  }
  return [];
}

function normalize(row, file, options) {
  if (!row || typeof row !== 'object') return null;
  const prompt = String(row.prompt ?? row.question ?? row.instruction ?? '').trim();
  const response = String(row.response ?? row.answer ?? row.output ?? '').trim();
  if (!prompt || !response) return null;
  const source = String(row.source ?? row.url ?? options.sourceName ?? path.basename(file)).trim();
  const license = String(row.license ?? options.license).trim();
  const normalized = { prompt, response, source, license };
  const hash = crypto.createHash('sha256')
    .update(`${prompt}\n${response}`)
    .digest('hex');
  return { ...normalized, id: hash };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = path.resolve(options.source);
  if (!fs.existsSync(source)) throw new Error(`Source does not exist: ${source}`);
  const files = filesFor(source, options.includeDocuments);
  fs.mkdirSync(options.output, { recursive: true });
  const seen = new Set();
  const counts = { files: files.length, read: 0, written: 0, duplicates: 0, rejected: 0 };
  const shards = [];
  let shard = null;
  let shardCount = 0;
  const closeShard = () => {
    if (!shard) return;
    shard.end();
    shard = null;
    shardCount = 0;
  };
  const openShard = () => {
    const name = `source-${String(shards.length + 1).padStart(5, '0')}.jsonl`;
    const file = path.join(options.output, name);
    shard = fs.createWriteStream(file, { encoding: 'utf8' });
    shards.push(name);
  };
  for (const file of files) {
    for (const row of readRows(file, options.includeDocuments, options.chunkCharacters)) {
      counts.read += 1;
      const normalized = normalize(row, file, options);
      if (!normalized) { counts.rejected += 1; continue; }
      if (seen.has(normalized.id)) { counts.duplicates += 1; continue; }
      if (counts.written >= options.maxRecords) break;
      if (!shard || shardCount >= options.shardSize) { closeShard(); openShard(); }
      seen.add(normalized.id);
      shard.write(`${JSON.stringify(normalized)}\n`);
      shardCount += 1;
      counts.written += 1;
    }
    if (counts.written >= options.maxRecords) break;
  }
  closeShard();
  const manifest = {
    generatedAt: new Date().toISOString(),
    source: source,
    records: counts,
    maxRecords: options.maxRecords,
    shardSize: options.shardSize,
    shards,
    note: 'Only import data you are licensed or authorized to use. Audit source and license fields before training.',
  };
  fs.writeFileSync(path.join(options.output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ output: options.output, ...manifest }, null, 2));
}

try { main(); } catch (error) {
  console.error(`Dataset import failed: ${error.message}`);
  process.exitCode = 1;
}
