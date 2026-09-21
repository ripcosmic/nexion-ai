# Nexion

Nexion is a standalone local AI with a purple theme. The default `models/nexion-brain.json` model is loaded and evaluated in the browser. No API keys are required.

Its own local model remains the only model unless you optionally enable Ollama. For a topic the model has not learned, the **online reference sources** setting can retrieve a cited Wikipedia reference. That is factual web retrieval, not a second AI model.

## Run it

```powershell
python -m http.server 4173
```

Or:

```powershell
node .\server.js
```

Open `http://localhost:4173`.

## Multi-user accounts and login

Nexion ships with a secure account system backed by a **private SQL database**:

- **Engine:** SQLite through Node's built-in `node:sqlite` module (Node >= 22.5).
  No native build step and no external database server are required.
- **Location:** `data/nexion.sqlite` by default, configurable with
  `NEXION_DB_FILE`/`NEXION_DATA_DIR`. The `data/` directory is git-ignored.
- **Passwords:** never stored in plain text. Each password is salted with a
  unique random salt and hashed with **scrypt** (`N=16384, r=8, p=1`). Hashes and
  salts are compared with `crypto.timingSafeEqual`.
- **Sessions:** random 256-bit tokens. Only the SHA-256 hash of a token is
  stored. The browser receives an `HttpOnly`, `SameSite=Lax` cookie that is
  marked `Secure` when `NODE_ENV=production` or `NEXION_SECURE_COOKIES=true`.
- **Rate limiting:** failed logins are recorded per email and per IP address;
  repeated failures are temporarily blocked.
- **Endpoints:** `POST /api/auth/register`, `POST /api/auth/login`,
  `GET /api/auth/me`, `POST /api/auth/logout`, and optional
  `POST /api/auth/request` + `GET /api/auth/verify` for passwordless email links.

Create an account from the **Log in → Create account** tab in the app. Chat
history and learned examples are still account-namespaced in the browser under
`nexion-*:user-<email>`.

```powershell
Copy-Item .env.example .env
node .\server.js
```

Set `APP_URL` to the public HTTPS URL in production. Do not commit `.env` or
database files. Use HTTPS so the `Secure` session cookie is effective.

## Account-isolated data

The browser client uses a separate storage namespace for every authenticated
email address:

- `nexion-chats:user-email%40example.com` stores that account's chat history.
- `nexion-learned-examples:user-email%40example.com` stores that account's learned examples.
- `nexion-chats:guest` and `nexion-learned-examples:guest` are used only before login.

This prevents two accounts using the same browser from seeing each other's local
history. It is still browser storage, so it does not synchronize across devices
and is not a substitute for a server database. After login, refreshing the page
loads the account namespace from the HTTP-only session cookie, and the login
button becomes a logout button.

## Database schema

`db.js` creates and owns the private SQL schema:

```sql
users          (id, email UNIQUE, display_name, password_hash, password_salt,
                password_algo, created_at, updated_at, last_login_at, is_active)
sessions       (token_hash PK, user_id -> users.id, created_at, expires_at,
                user_agent, ip_address)
login_tokens   (token_hash PK, user_id -> users.id, created_at, expires_at)
login_attempts (id, email, ip_address, succeeded, attempted_at)
```

Foreign keys cascade on user deletion. WAL mode and `synchronous=NORMAL` are
enabled for safe concurrent reads. The connection enables `foreign_keys=ON`.

### Optional: managed SQL (PostgreSQL) or Firebase

SQLite is private and zero-config, which is ideal for a single server. If you
need a managed, multi-region database, swap `db.js` for PostgreSQL (`npm install
pg`) or Firestore (`npm install firebase-admin`) using the same tables and the
same ownership rule: **resolve the user from the session cookie server-side and
never trust a `user_id` sent by the browser.**

### Firebase audit logging

The current server can use Firebase Firestore as an audit database while
continuing to use private SQLite for credentials and HTTP-only sessions. Set all
three Firebase variables in `.env`, or point `FIREBASE_SERVICE_ACCOUNT_FILE` at
the downloaded service-account JSON file:

```env
FIREBASE_SERVICE_ACCOUNT_FILE=./your-firebase-service-account.json
```

Alternatively:

```env
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project-id.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

To configure it:

1. Open the Firebase console and create or select a project.
2. Open **Project settings → Service accounts** and create a private key.
3. Either set `FIREBASE_SERVICE_ACCOUNT_FILE` to the downloaded JSON path, or
   copy its `project_id`, `client_email`, and `private_key` into the variables
   above. Keep both the JSON file and `.env` private; never put these values in
   browser JavaScript.
4. Enable Firestore Database in the Firebase console.
5. Start the server with `npm start`.

Events are written to the `audit_events` collection. Documents contain the
event category, event name, timestamp, request path, status code when
available, user ID/email when known, IP address, and user agent. The server
records successful and failed registration, password login, magic-link login,
logout, and every `/api/*` request.

Firebase is optional for local development. If the variables are missing, the
server logs that Firebase audit is disabled and continues using SQLite. Audit
writes are non-blocking and cannot make a login or API request fail. Passwords,
session tokens, magic-link tokens, and request bodies are never written to the
audit collection.

## Train the local brain

### OpenRouter-assisted local tuning

OpenRouter provides chat-completions routing, not a general model-weight
fine-tuning endpoint. Nexion includes a safe alternative that uses OpenRouter
to expand and improve local prompt/response examples, then trains the local
retrieval model from those examples.

1. Revoke any OpenRouter key previously pasted into chat and create a new one.
2. Put the replacement only in `.env`:

   ```env
   OPENROUTER_API_KEY=your-new-key
   OPENROUTER_MODEL=openrouter/free
   OPENROUTER_VARIANTS=2
   OPENROUTER_MAX_EXAMPLES=500
   ```

3. Generate an augmented JSONL dataset:

   ```powershell
   npm run generate:openrouter-dataset
   ```

   The command writes `training/openrouter-augmented.jsonl`, keeps a resumable
   checkpoint beside it, and never writes the API key to disk or sends the full
   project directory.
4. Rebuild Nexion's local model:

   ```powershell
   .\.venv\Scripts\python.exe .\brain.py train
   ```

This workflow spends OpenRouter credits on high-quality example generation.
It does not modify the weights of the remote OpenRouter model. Actual weight
fine-tuning still requires a provider with a fine-tuning API or local
Unsloth/QLoRA training.

Add original, trusted question/answer rows to a `.jsonl` file in `training/`. Each row needs `prompt` and `response` fields. Code answers should use fenced markdown blocks so the chat UI can render them.

```json
{"prompt":"python hello world code", "response":"```python\nprint(\"Hello, world\")\n```"}
```

Then rebuild:

```powershell
python .\brain.py train
```

Nexion checks the local model file every 30 seconds. Your next message uses the newest trained model.

Included datasets:

- `training/dataset.jsonl` — identity and how to use Nexion
- `training/core.jsonl` — general knowledge
- `training/code.jsonl` — Python, JavaScript, HTML, CSS, SQL, and related examples

Turn on **code mode** with the `{ }` button when you want Nexion to prefer code answers.

## Optional: Ollama 1B model

Install and start [Ollama](https://ollama.com/), then open **Settings** and select **Ollama Nexion model**. Choose a base model (default `llama3.2:1b`) and select **Build & activate Nexion**. That creates a local `nexion-safe` model.

```powershell
python .\brain.py ollama --base-model llama3.2:3b --model nexion-safe
```

The default target is `llama3.2:1b`, a model with approximately one billion
parameters. The rebuild now includes the JSONL examples in the model's system
context, so they affect the Ollama model's behavior. This is prompt-conditioned
customization, not a weight fine-tune: changing the parameter count or adding
examples to a JSON file cannot train new neural weights. True weight fine-tuning
requires a separate training stack, substantial data, and suitable GPU memory.

## Fine-tune with Unsloth (QLoRA)

The repository also includes [`scripts/finetune_unsloth.py`](./scripts/finetune_unsloth.py)
for real supervised fine-tuning. It trains a small LoRA adapter on the JSONL
prompt/response examples instead of changing the browser retrieval JSON.

Unsloth is best run in Linux or WSL2 with an NVIDIA CUDA GPU. The Windows
`.venv` in this repository currently contains only `pip`; do not install the
CUDA training stack into it blindly. In WSL, from the project directory:

```bash
python3 -m venv .venv-unsloth
source .venv-unsloth/bin/activate
python -m pip install --upgrade pip
python -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
python -m pip install -r requirements-unsloth.txt
python scripts/finetune_unsloth.py \
  --base-model unsloth/Llama-3.2-1B-Instruct \
  --output-dir models/nexion-unsloth-lora
```

In VS Code, run **Terminal → Run Task → Nexion: Install Unsloth in WSL**
once, then run **Terminal → Run Task → Nexion: Fine-tune with Unsloth**.
These tasks use [`scripts/run_unsloth_wsl.ps1`](./scripts/run_unsloth_wsl.ps1)
to preserve the Windows workspace path while training inside WSL.

Ollama model training is intentionally separate from chat generation. Use the
CLI command below to build the customized model; it creates the model and exits
without sending a prompt or displaying an AI response:

```powershell
python .\brain.py ollama --base-model llama3.2:1b --model nexion-safe
```

By default this saves a **LoRA adapter**. To export a **standalone full LLM**
(merged base + adapter weights), pass `--save-method merged_16bit` (or
`merged_4bit`). To also produce a GGUF file for Ollama/llama.cpp, add
`--export-gguf`:

```bash
python scripts/finetune_unsloth.py \
  --base-model unsloth/Llama-3.2-1B-Instruct \
  --save-method merged_16bit \
  --export-gguf --gguf-quant q4_k_m
```

The Windows helper exposes the same options:

```powershell
# Merged standalone model + GGUF export via WSL
.\scripts\run_unsloth_wsl.ps1 -Install -SaveMethod merged_16bit -ExportGguf
```

A merged checkpoint is a complete, self-contained language model that can be
served directly. A few hundred examples will mostly teach style and formatting;
broader factual knowledge requires a much larger, licensed, high-quality corpus
and an evaluation set. Merging also needs enough disk space for full-precision
weights.

## Deploy to Netlify

Netlify can host the frontend and the Ollama proxy, but it cannot run Ollama
itself. Deploy this project as a Netlify site and configure the site environment
variable `OLLAMA_BASE_URL` to the HTTPS URL of a separately hosted Ollama
server. That server must have `nexion-safe` installed and must be protected with
network controls or authentication.

The included `netlify.toml` publishes the project and routes `/api/ollama/*` to
the `netlify/functions/ollama.js` function. When the site is opened outside
localhost, Nexion automatically uses `/.netlify/functions/ollama`.

For a private deployment, set `ALLOWED_ORIGIN` to the exact Netlify site origin,
for example `https://your-site.netlify.app`, instead of leaving CORS open. Never
put Ollama credentials or API keys in `app.js`.

## Privacy and limits

Account credentials live only in the private server SQL database, never in the
browser. Chat history and learned examples are account-namespaced in browser
local storage and are not yet synced to the server database. The default brain
can answer only from training material, including the code examples. Generated
code should be reviewed before you run it.
