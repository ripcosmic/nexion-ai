"""Nexion Brain: a fully local, from-scratch trainable text-retrieval model.

It does not download or invoke external models. Training creates only the model
weights/index from the JSONL material in training/.
"""
import argparse
import json
import math
import re
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).parent
DATASET = ROOT / 'training' / 'dataset.jsonl'
DEFAULT_MODEL = ROOT / 'models' / 'nexion-brain.json'
STOPWORDS = {'a', 'an', 'and', 'are', 'as', 'at', 'be', 'can', 'could', 'do', 'does', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'please', 'tell', 'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'would', 'you', 'your'}
TARGET_TOPICS = 500_000
TARGET_SUBTOPICS_PER_TOPIC = 500_000
NEXION_SYSTEM = (
    'You are Nexion, a warm, capable local AI assistant. Be conversational. '
    'When the user wants code, return complete runnable examples in fenced markdown '
    'code blocks with a language tag, plus a short explanation. '
    'Follow Nexion style: use clear headings, definitions, detailed explanations, '
    'examples, practical steps, and an In short summary. '
    'Use your base-model knowledge when appropriate, distinguish facts from guesses, '
    'and say when you are uncertain. Never claim to know everything or invent an answer.'
)

def words(value):
    return [word for word in re.findall(r"[a-z0-9']{2,}", value.lower()) if word not in STOPWORDS]

def training_files(dataset):
    requested = Path(dataset)
    return sorted(requested.parent.glob('*.jsonl')) if requested == DATASET else [requested]

def iter_training_rows(dataset):
    for source in training_files(dataset):
        with source.open(encoding='utf8') as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as error:
                    raise ValueError(f'Invalid JSON in {source}:{line_number}: {error.msg}') from error
                if not isinstance(row.get('prompt'), str) or not isinstance(row.get('response'), str):
                    raise ValueError(f'Every training row in {source}:{line_number} must have string prompt and response fields.')
                yield source, line_number, row

def corpus_check(dataset=DATASET, topic_field='topic', subtopic_field='subtopic'):
    topics = Counter()
    topic_subtopics = defaultdict(set)
    total = 0
    unlabelled_topics = 0
    unlabelled_subtopics = 0
    for _, _, row in iter_training_rows(dataset):
        total += 1
        topic = row.get(topic_field)
        if isinstance(topic, str) and topic.strip():
            topic = topic.strip()
            topics[topic] += 1
            subtopic = row.get(subtopic_field)
            if isinstance(subtopic, str) and subtopic.strip():
                topic_subtopics[topic].add(subtopic.strip())
            else:
                unlabelled_subtopics += 1
        else:
            unlabelled_topics += 1
    qualifying = sum(len(topic_subtopics[topic]) >= TARGET_SUBTOPICS_PER_TOPIC for topic in topics)
    result = {
        'dataset_rows': total,
        'labelled_topics': len(topics),
        'labelled_subtopics': sum(len(values) for values in topic_subtopics.values()),
        'topics_with_500000_subtopics': qualifying,
        'unlabelled_topics': unlabelled_topics,
        'unlabelled_subtopics': unlabelled_subtopics,
        'requested_topics': TARGET_TOPICS,
        'requested_subtopics_per_topic': TARGET_SUBTOPICS_PER_TOPIC,
        'requested_total_topic_subtopic_pairs': TARGET_TOPICS * TARGET_SUBTOPICS_PER_TOPIC,
        'target_reached': len(topics) >= TARGET_TOPICS and qualifying >= TARGET_TOPICS,
    }
    print(json.dumps(result))

def train(dataset=DATASET, output=DEFAULT_MODEL):
    examples = []
    files = training_files(dataset)
    for source, _, row in iter_training_rows(dataset):
        counts = Counter(words(row['prompt']))
        if counts:
            examples.append({'prompt': row['prompt'], 'response': row['response'], 'counts': counts})
    if not examples:
        raise ValueError('No usable training examples were found.')
    document_frequency = Counter()
    for example in examples:
        document_frequency.update(example['counts'].keys())
    total = len(examples)
    vocabulary = {term: math.log((total + 1) / (frequency + 1)) + 1 for term, frequency in document_frequency.items()}
    for example in examples:
        vector = {term: count * vocabulary[term] for term, count in example['counts'].items()}
        length = math.sqrt(sum(value * value for value in vector.values())) or 1
        example['vector'] = {term: value / length for term, value in vector.items()}
        del example['counts']
    output = Path(output); output.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({'format': 'nexion-brain-v1', 'trained_at': datetime.now(timezone.utc).isoformat(), 'examples': examples, 'vocabulary': vocabulary}, ensure_ascii=False, indent=2)
    temporary = output.with_suffix('.tmp')
    temporary.write_text(payload, encoding='utf8')
    temporary.replace(output)
    print(json.dumps({'trained': True, 'examples': total, 'datasets': [str(file) for file in files], 'model': str(output)}))

def respond(model_path, prompt):
    model = json.loads(Path(model_path).read_text(encoding='utf8'))
    basic_replies = {
        'hello': 'Hello! I am Nexion, your AI assistant. How can I help you today?',
        'hello nexion': 'Hello! I am Nexion, your AI assistant. How can I help you today?',
        'hi': 'Hi there! I am Nexion, your AI assistant. What can I do for you?',
        'hey': 'Hey! I am Nexion, your AI assistant. How can I help?',
        'how are you': 'I’m doing well and ready to help. What would you like to work on?',
        'how are you doing': 'I’m doing well, thank you! I’m ready to help with questions, ideas, research, or code.',
        'who are you': 'I am Nexion, your AI assistant. I’m here to answer questions, explain concepts, and help you create practical solutions.',
        'what is your name': 'My name is Nexion. I am your AI assistant, and I can help with explanations, ideas, planning, and code.',
    }
    normalized_prompt = re.sub(r'\s+', ' ', prompt.strip().lower()).strip('!?.,')
    if normalized_prompt in basic_replies:
        print(json.dumps({'reply': basic_replies[normalized_prompt], 'confidence': 1.0}))
        return
    query_counts = Counter(words(prompt))
    weighted = {term: query_counts[term] * model['vocabulary'][term] for term in query_counts if term in model['vocabulary']}
    length = math.sqrt(sum(value * value for value in weighted.values())) or 1
    query = {term: value / length for term, value in weighted.items()}
    def score(example):
        return sum(weight * example['vector'].get(term, 0) for term, weight in query.items())
    best = max(model['examples'], key=score)
    confidence = score(best)
    if 'LOCAL KNOWLEDGE:' in prompt:
        knowledge = prompt.split('LOCAL KNOWLEDGE:', 1)[1].strip()
        if knowledge:
            reply = f"Based on your local knowledge base:\n\n{knowledge[:1800]}"
        else:
            reply = best['response']
    elif confidence >= 0.13:
        reply = best['response']
    else:
        reply = "I have not understood that term yet. Could you repeat it in a different way or explain what you mean?"
    print(json.dumps({'reply': reply, 'confidence': round(confidence, 4)}))

def ollama_train(dataset=DATASET, base_model='llama3.2:1b', model_name='nexion-safe', url='http://127.0.0.1:11434'):
    files = training_files(dataset)
    examples = []
    for _, _, row in iter_training_rows(dataset):
        examples.append(row)
    if not examples:
        raise ValueError('No usable training examples were found.')
    if not re.search(r'(^|:)1b($|[-:])', base_model.lower()):
        raise ValueError(
            f'The Nexion 1B build requires a 1B Ollama base model; received {base_model!r}. '
            'Pass --base-model llama3.2:1b or another explicitly 1B model.'
        )

    examples_context = '\n\n'.join(
        f'Example {index}:\nUser: {row["prompt"]}\nNexion: {row["response"]}'
        for index, row in enumerate(examples, 1)
    )

    def request(path, payload):
        body = json.dumps(payload).encode('utf8')
        try:
            with urlopen(Request(f'{url.rstrip("/")}{path}', data=body, headers={'Content-Type': 'application/json'}), timeout=30) as response:
                return json.loads(response.read().decode('utf8'))
        except HTTPError as error:
            detail = error.read().decode('utf8', errors='replace')
            raise RuntimeError(f'Ollama request {path} failed ({error.code}): {detail}') from error
        except URLError as error:
            raise RuntimeError(f'Could not reach Ollama at {url}. Start Ollama and try again.') from error

    request('/api/pull', {'model': base_model, 'stream': False})
    request('/api/create', {
        'model': model_name,
        'from': base_model,
        'stream': False,
        'system': (
            f'{NEXION_SYSTEM}\n'
            'For a simple greeting such as hello, hi, or hey, respond with a brief natural greeting. '
            'Do not explain or define the greeting unless the user explicitly asks for its definition.\n\n'
            'The following project examples are behavioral guidance. Follow their style '
            'and facts when relevant, but do not claim that they are user messages in the '
            'current conversation:\n\n'
            f'{examples_context}'
        ),
        'parameters': {'temperature': 0.3, 'num_ctx': 16384},
    })
    print(json.dumps({
        'trained': True,
        'examples': len(examples),
        'datasets': [str(file) for file in files],
        'base_model': base_model,
        'parameter_target': '1B',
        'training_method': 'Ollama prompt-conditioned customization (not weight fine-tuning)',
        'model': model_name,
    }))

parser = argparse.ArgumentParser(description='Train or run the private Nexion Brain.')
sub = parser.add_subparsers(dest='command', required=True)
train_parser = sub.add_parser('train'); train_parser.add_argument('--dataset', default=str(DATASET)); train_parser.add_argument('--output', default=str(DEFAULT_MODEL))
check_parser = sub.add_parser('corpus-check', help='Audit a JSONL corpus against the 500,000-topic target.')
check_parser.add_argument('--dataset', default=str(DATASET))
check_parser.add_argument('--topic-field', default='topic')
check_parser.add_argument('--subtopic-field', default='subtopic')
ollama_parser = sub.add_parser('ollama', help='Build a customized model in a local Ollama instance.')
ollama_parser.add_argument('--dataset', default=str(DATASET))
ollama_parser.add_argument('--base-model', default='llama3.2:1b')
ollama_parser.add_argument('--model', default='nexion-safe')
ollama_parser.add_argument('--url', default='http://127.0.0.1:11434')
reply_parser = sub.add_parser('reply'); reply_parser.add_argument('--model', default=str(DEFAULT_MODEL)); reply_parser.add_argument('--prompt', required=True)
args = parser.parse_args()
if args.command == 'train': train(args.dataset, args.output)
elif args.command == 'corpus-check': corpus_check(args.dataset, args.topic_field, args.subtopic_field)
elif args.command == 'ollama': ollama_train(args.dataset, args.base_model, args.model, args.url)
else: respond(args.model, args.prompt)
