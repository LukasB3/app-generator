# App Generator

Type a request such as "a 5-minute timer with a QR code" and get a link to a working, deployed web app a few minutes later. A coding agent (Claude Code, headless) builds it; everything around the agent is ordinary, deterministic code.

The project is built on one assumption: **every prompt is malicious and the agent can be fully hijacked.** Nothing the agent can reach is worth stealing, and nothing it produces is published without passing checks it has no influence over.

## How a request flows

```mermaid
flowchart LR
  V[Visitor] -->|prompt + captcha| W[Website<br/>Vercel]
  W -->|POST /api/jobs, SSE| O[Orchestrator<br/>queue, one job at a time]
  subgraph VPS[Hetzner VPS]
    O -->|job id| L[Launcher<br/>root-owned, fixed settings]
    L -->|starts, kills| S[Sandbox container<br/>Claude Code, file tools only]
    S -->|job token| P[Key proxy<br/>holds the API key]
    O -->|reads workspace| C[Checker<br/>plain code]
    C --> G[Publisher<br/>git + deploy key]
  end
  P -->|vetted Messages calls| A[Anthropic API]
  G -->|apps/&lt;job-id&gt;/| R[app-generator-apps<br/>GitHub Pages]
  R -->|link| V
```

1. The website sends the prompt and a Turnstile token to the orchestrator.
2. The orchestrator applies the limits and has a small model screen the prompt: gibberish and abusive requests are turned away with a message before anything is queued. Then it queues the job and streams progress back (`queued → preparing → coding → checking → publishing → done`), including the files the agent writes.
3. For each job a fresh container starts with an empty workspace. The agent has the Read, Write, Edit, Glob and Grep tools and nothing else.
4. When the agent stops, the checker validates the workspace. If it finds problems, the agent gets one repair round with the findings.
5. The publisher commits the checked files to `apps/<job-id>/` in a dedicated repository and waits until GitHub Pages serves them.

## Security model

| Concern | What is done about it |
| --- | --- |
| Agent runs commands or reaches the network | No shell or web tools (`--restricted`, fixed tool list baked into the image). Container: non-root, read-only root filesystem, all capabilities dropped, memory, CPU and process limits. Its network is internal with no gateway on the host, so the only reachable address is the key proxy. |
| Agent steals the API key | The key exists only in the proxy's environment. The container gets an HMAC-signed token bound to the job id and the job deadline. |
| Agent abuses the API through the proxy | Only `POST /v1/messages` is forwarded. Model allow-list, `max_tokens` cap, and a budget per job in requests, output tokens and dollars: the proxy meters every kind of token against a price table, and charges an answer that is cut short as if it had run in full. Requests that carry server tools (web search, web fetch, code execution) or MCP servers are refused, since those would give the sandbox a way out through Anthropic's side. |
| Web-facing process gets compromised | The orchestrator has no Docker access. It can only ask a root-owned launcher to start or kill the container for a job id; image, network, limits and mounts are fixed there. |
| Agent gets at git or GitHub | The image has no git and no credentials. The orchestrator publishes with a deploy key that is valid for the apps repository only. |
| Malicious output is published | The checker allows only `.html`, `.css`, `.js`, `.json` and `.txt` within size and count limits, rejects symlinks, secrets, inline scripts, external or absolute URLs, iframes, password and card fields, and forms that submit anywhere. HTML is re-serialised with a strict CSP (`connect-src 'none'`, `form-action 'none'`, `script-src 'self'`) and a visible "AI-generated" badge. |
| Injection through the prompt | The prompt reaches the agent on stdin only. Job ids are generated server-side and are the only request-derived value in any path or command. Every subprocess is started with an argument array, never through a shell. |
| Nonsense or abusive requests | One short classification call (Claude Haiku 5.5, through the key proxy with a job token) before a job is queued. It is a courtesy filter, not a boundary: its answer is one of three fixed values, and a prompt that fools it only reaches the sandbox and the checker like any other. If the call fails, the request goes through. |
| Abuse and cost | Turnstile, per-visitor and global hourly/daily limits, a bounded queue, one job at a time, a hard timeout that kills the container. What each job cost is stored, and new jobs are turned away once a visitor's day, the day or the month has used its budget. The spend limit on the dedicated Anthropic workspace is the outer bound. |

The full reasoning, including the trade-offs that remain, is in [docs/threat-model.md](docs/threat-model.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `web/` | The website: Vite, TypeScript, no framework. Deployed to Vercel. |
| `orchestrator/` | API, queue, sandbox runner, checker, publisher and the key proxy (Node 22, TypeScript, Fastify, built-in SQLite). |
| `sandbox/` | Image for the agent container, its system prompt and the bundled libraries. |
| `infra/` | Provisioning and deploy scripts, sandbox launcher, Caddy config, systemd unit, compose file. |

## Development

```sh
nvm use

cd orchestrator
npm ci
npm test          # checker, proxy, launcher, token, API and queue tests
npm run typecheck

cd ../web
npm ci
npm run dev       # expects the API on http://localhost:8787
```

The tests cover the parts that carry the security claims: what the checker rejects, what the proxy refuses to forward, the limits of the API, and the flags the sandbox is started with.

## Deployment

On a fresh Ubuntu 24.04 or 26.04 server:

```sh
sudo API_DOMAIN=api.app-generator.example WEB_ORIGIN=https://app-generator.example ./infra/provision.sh
# add the printed deploy key to the apps repository (write access)
# put the Anthropic key into /etc/app-generator/anthropic.env
# put the Turnstile secret into /etc/app-generator/orchestrator.env
sudo ./infra/deploy.sh
```

The website is a Vercel project with `web/` as its root directory and `VITE_API_BASE` and `VITE_TURNSTILE_SITEKEY` set.

## Limits

| Setting | Default |
| --- | --- |
| Jobs running at once | 1 |
| Job timeout | 15 minutes |
| Job budget | 120 requests, 250,000 output tokens, $4 |
| Jobs per visitor | 3 per hour, $5 per day |
| Jobs overall | 10 per hour, 30 per day, $10 per day, $90 per 30 days |
| Queue length | 10 |
| Prompt length | 1,000 characters |
| App size | 30 files, 300 kB per file, 1.5 MB in total |
| App lifetime | 30 days, then removed from the apps repository |

Dollar budgets count what finished jobs have cost, so jobs that are still waiting or running can take a total past its budget, each by at most the cap for one job.

Generated apps can load three bundled libraries and nothing else from outside their own files: a QR code generator, Chart.js, and Preact with htm. They are listed with versions and checksums in [sandbox/libs/README.md](sandbox/libs/README.md).
