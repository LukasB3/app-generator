# Threat model

## Assumptions

- Every prompt is written by an attacker.
- The model follows the attacker's instructions completely. The system prompt is a quality measure, not a control.
- The attacker knows this repository.

The goal is that under these assumptions the attacker gains nothing beyond a static page that passed the checker.

## What is worth protecting

| Asset | Where it lives | Who can read it |
| --- | --- | --- |
| Anthropic API key | `/etc/app-generator/anthropic.env`, environment of the proxy container | root |
| Deploy key for the apps repository | `/etc/app-generator/deploy_key` | orchestrator user |
| The host | | |
| Visitors of published apps | their browsers | |
| The budget | Anthropic workspace | |
| Accounts: e-mail addresses and logins | Supabase project (Auth) | Supabase; the one database login on this server is for a role that cannot read them |
| Password of the database gateway's role | `/etc/app-generator/dbgate.env`, environment of the gateway container | root |

## Trust boundaries

1. **Internet → orchestrator API.** Untrusted HTTP. Input is a prompt of limited length and a captcha token, validated with a schema, and optionally a login token. Job ids in URLs must match a fixed pattern before they touch the database.
2. **Orchestrator → launcher → sandbox.** The orchestrator cannot talk to Docker. It hands a job id, a job token and the prompt to a root-owned launcher, which starts the container with fixed settings. Exactly three things reach the container: the prompt on stdin, the token in the environment, and a workspace. The workspace holds the bundled libraries and, when an existing app is being changed, that app's files as they last passed the checker. The agent's command line is fixed in the image.
3. **Sandbox → key proxy.** The only network path out of the sandbox. The proxy treats the container as hostile.
4. **Sandbox → orchestrator (the workspace).** Whatever the agent wrote is hostile data. It is read by the checker and never executed on the server.
5. **Orchestrator → GitHub.** Git runs with a deploy key scoped to one repository and a pinned host key.
6. **Published app → visitor.** The app runs in the visitor's browser under a policy the agent cannot change.
7. **Orchestrator → database gateway → database.** The gateway holds the one database login. It takes a short list of table changes from the orchestrator, never SQL, and no sandbox can reach it yet.

## Threats and controls

### The hijacked agent tries to act on the server

- It has no tool that executes anything. Claude Code runs with `--restricted` and a fixed list of file tools, set in the image's entrypoint.
- File tools are confined to the workspace. Even without that, the container's root filesystem is read-only and holds nothing of value.
- The container runs as an unprivileged user with all capabilities dropped, `no-new-privileges`, and limits on memory, CPU and process count.
- The sandbox network is an internal Docker network without a host-side gateway address. From inside, the internet, the host's own services and the cloud metadata address are unreachable. This was verified by probing from a container, and the first version failed that probe: the host's SSH port answered on the bridge gateway until the gateway was removed.
- A job that exceeds its time limit is killed, and the container is removed after every job.

### The hijacked agent tries to steal or abuse the API key

- The key is not in the container. The agent holds a token of the form `pgj1.<job>.<expiry>.<hmac>` that only the proxy accepts and that expires with the job.
- If the agent writes that token into the app, the checker rejects the app. Outside the server the token is useless anyway: the proxy listens on the sandbox network and on the host's loopback address (for the prompt screen), and nowhere else.
- The proxy forwards only `POST /v1/messages`, only for models it has a price for, with `max_tokens` capped. It counts input, output and cache tokens of every answer, turns them into dollars, and stops forwarding once a job has used its budget in requests, output tokens or dollars.
- An answer that ends without its final token count is charged as if it had run in full, so hanging up early is no way around the budget.
- The proxy refuses requests that declare server-side tools or MCP servers. Without this, code running in the container could ask Anthropic's servers to fetch URLs on its behalf.
- The proxy forwards four request headers and nothing else, and is built from Node built-ins only.

### The hijacked agent tries to publish something harmful

The checker is plain code and decides alone. It rejects:

- anything that is not a regular `.html`, `.css`, `.js`, `.json` or `.txt` file with a plain name, within the size limits;
- files that contain known credential formats, a job token or one of the server's own secrets;
- inline scripts and event handlers, scripts and resources from other origins, absolute or parent-relative URLs, `javascript:` URLs, references to files that do not exist;
- `<iframe>`, `<object>`, `<embed>`, `<base>`, meta refresh, preconnect and prefetch hints;
- forms with a target, password fields and fields that ask for card data or credentials;
- external URLs in CSS and in scripts.

HTML that passes is parsed and written out again with three additions at the very top of `<head>`: a Content Security Policy, a job marker and a no-referrer policy. A badge marking the page as AI-generated is appended to `<body>`. An existing policy from the agent is dropped.

The policy is the actual enforcement. With `connect-src 'none'`, `form-action 'none'` and `script-src 'self'`, a page cannot send data anywhere or load code from elsewhere, whatever its scripts try. The checks before it exist so that a rejected app fails loudly with a reason instead of being published broken.

### The attacker targets the pipeline itself

- **Command injection.** The prompt is never part of a command line, a path or a commit message. Subprocesses (`sudo`, `git`) are started with argument arrays. The only request-derived value used in paths is the job id, which the server generates from random bytes.
- **Path tricks in the workspace.** Symlinks, special files, dotfiles, odd names and deep nesting are rejected before any content is read. Output paths are built from names that passed a strict pattern.
- **Tampering with bundled libraries.** The agent's copy of `lib/` is ignored. Referenced libraries are published from the pristine copies on the server.
- **Leaking internals through errors.** Visitors see fixed messages. Details go to the server log.

### The attacker targets the budget or the service

- Turnstile in front of job creation, verified on the server.
- Three jobs per visitor per hour (IPv6 visitors are counted per /64, logged-in visitors by account as well), ten per hour and thirty per day overall, a queue of ten.
- One job at a time, each with a hard timeout and a budget in tokens and dollars.
- The orchestrator stores what each job cost, as the proxy counted it, and turns new jobs away once a visitor's day, the day or the last 30 days have used their budget. The cost of a job is known when it ends, so jobs already waiting can overshoot a budget, each by at most the cap for one job.
- A prompt screen in front of the queue. After the captcha and the limits, the orchestrator asks a small model (Claude Haiku 5.5) whether the text is a request for an app, gibberish, or abusive, and turns the last two away with a fixed message. The call goes through the key proxy with a 30-second job token, so the orchestrator still never holds the API key and the proxy's vetting and logging apply.
- The screen is not a security control and nothing depends on it. The visitor's text is passed as data, the answer is constrained to three fixed values, and a prompt that talks the model into "ok" gets what every prompt gets: the sandbox and the checker. If the call fails or times out, the request is let through.
- A screened-out prompt costs one small model call and no job. Each attempt needs a fresh captcha and the route accepts ten requests per visitor per minute.
- A monthly spend limit on the Anthropic workspace as the outer bound.
- Visitor addresses are stored only as keyed hashes. Job records are deleted after 30 days. Published apps are removed from the apps repository after one day, or after ten for an app requested from an account.

### The attacker targets the accounts

- Logging in is optional and has no password to steal: Supabase Auth mails a link and a code. The orchestrator verifies each login token against the project's public keys, with the algorithm, issuer and audience pinned, and uses nothing from it but the account id. Other claims in a token are partly written by the user.
- The website holds only the publishable key. The server holds one Supabase credential: the password of the database gateway's role, which has no way to the accounts (next section). A break-in here yields no access to the addresses.
- A token that does not verify ends the request. It is never read as "not logged in", which would hand the visitor an anonymous app they believe is theirs.
- An account costs nothing to create, so it buys nothing an address does not already get: the hourly limit and the daily budget are counted per address and per account. What an account changes is the lifetime of its apps.
- The list of someone's apps is answered only for the account in a verified token. Watching a build still needs nothing but the job id, as before.
- Only the owner can change an app, and only one change runs at a time. Anyone else gets the same answer as for an app that does not exist. A change counts against the same limits and budgets as a new app and never moves the day the app is removed.
- A change starts from files an agent wrote earlier. Passing the checker once earns them no trust: the whole app goes through the checker again, and what is stored is the text the checker read, not what was in the workspace afterwards. Whatever those files say to the next agent, they were written at the request of the same account.
- A change that is still waiting when its app ends is not published: the publisher asks again once it holds the repository, the same moment the cleanup decides.
- Anyone can ask for a login mail to any address. The form is behind a captcha that Supabase checks, and Supabase limits how often mail goes out, in total and per address.

### The attacker targets the database

Generated apps are going to get tables of their own, in the Supabase project that also holds the accounts. So far only the groundwork exists: a gateway that creates and removes such tables. No agent can reach it yet. It is not on the sandbox network, its port is open on the host's loopback address only, and its routes answer only to a pass from the orchestrator, signed with a secret of its own and good for 30 seconds.

- **No SQL comes from outside.** The gateway accepts a list of changes: create a table, add a column. It builds every statement itself. A name must match a strict pattern before it is quoted, types and access modes come from fixed lists, and a refusal never repeats the input that failed.
- **The gateway's role cannot get at the accounts.** It is a member of no other role and has rights on one schema, `apps`, which holds nothing but the apps' tables. Tried on the project with a role of the same making: `auth`, `storage`, the vault, other roles' passwords, files and programs on the database server are all refused.
- **The gateway checks its own role.** Before it does any work it asks the database what its role is and what it may use. If the role has gained a special power, a membership or a schema it has no business in, the gateway refuses to work until it is restarted. Its statements are only as harmless as the role that runs them.
- **The password never left the server in the clear.** The server makes it. The database is given a SCRAM verifier of it, which is what Postgres stores anyway; the statement that sets it can sit in an editor's history or a log without giving the password away. The connection is encrypted and checked against Supabase's certificate authority.
- **What visitors can do to a table is decided when it is made.** Every table gets row level security, explicit grants to the visitors' role and nothing for logged-in accounts. Visitors can read and add rows, in tables made for it also change and delete them, and never set a row's id or time. A trigger caps a row at 2 kB and a table at 500 rows; an app gets three tables, all apps together 150.
- **Tables go when their app goes.** Once an hour the orchestrator sends the list of live apps and the gateway drops every table of its own that belongs to none of them. Tables it did not make are never touched.

What remains: the role can create any kind of object in `apps`, not only tables. It can also install the extensions Supabase offers, because Supabase lets every database role do that, and some of those make requests from the database server. It can fill the database, which would stop logins as well, since both live in one project. None of this is within reach of a visitor or an agent. It would take control of the gateway itself, whose only input is the orchestrator's.

## Known trade-offs

- **The launcher runs as root.** The orchestrator has no access to the Docker socket. It may run one root-owned script through sudo, `ag-sandbox run|kill <job-id>`, which validates the id and the job token and then starts a container whose every other setting is fixed in the script and a root-owned config file. A bug in that script would be serious, so it is short and tested. The price is that the service cannot use `NoNewPrivileges` and the systemd options that imply it.
- **Navigation cannot be blocked.** No browser policy stops a script from redirecting the top-level page. The checker rejects scripts that contain external URLs, but an obfuscated one would pass. The page could then send the visitor to another site, without being able to read or submit anything first.
- **Shared origin on github.io.** All published apps share one origin with each other and with other project pages of the same account. They can read each other's local storage. Nothing sensitive may ever be hosted on that origin.
- **The checker is not a content filter.** It enforces what a page can do, not what it says. Offensive text passes. The badge, the captcha and the ability to delete an app are the answer to that.
- **Policy as a meta tag.** GitHub Pages cannot send response headers, so the policy is delivered in the document. `frame-ancestors` is not available that way, so apps can be framed by other sites.
