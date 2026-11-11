# Threat model

## Assumptions

- Every prompt is written by an attacker.
- The model follows the attacker's instructions completely. The system prompt is a quality measure, not a control.
- The attacker knows this repository.

The goal is that under these assumptions the attacker gains nothing beyond a static page that passed the checker, with at most three small public tables behind it.

## What is worth protecting

| Asset | Where it lives | Who can read it |
| --- | --- | --- |
| Anthropic API key | `/etc/app-generator/anthropic.env`, environment of the proxy container | root |
| Deploy key for the apps repository | `/etc/app-generator/deploy_key` | orchestrator user |
| The host | | |
| Visitors of published apps | their browsers | |
| What visitors enter into apps with tables | Supabase project (schema `apps`) | everyone: it is public by design |
| The budget | Anthropic workspace | |
| Accounts: e-mail addresses and logins | Supabase project (Auth) | Supabase; the one database login on this server is for a role that cannot read them |
| Password of the database gateway's role | `/etc/app-generator/dbgate.env`, environment of the gateway container | root |

## Trust boundaries

1. **Internet → orchestrator API.** Untrusted HTTP. Input is a prompt of limited length and a captcha token, validated with a schema, and optionally a login token. Job ids in URLs must match a fixed pattern before they touch the database.
2. **Orchestrator → launcher → sandbox.** The orchestrator cannot talk to Docker. It hands a job id, a job token and the prompt to a root-owned launcher, which starts the container with fixed settings. Exactly four things reach the container: the prompt on stdin, two tokens in the environment (one for the key proxy, one for the database gateway's tools), and a workspace. The workspace holds the bundled libraries and, when an existing app is being changed, that app's files as they last passed the checker. The agent's command line is fixed in the image.
3. **Sandbox → key proxy.** The only network path from the sandbox to the outside world. The proxy treats the container as hostile.
4. **Sandbox → database gateway.** The second and last address a sandbox can reach. The agent has three tools there, and all they do is have the gateway write down which tables the job's app should get.
5. **Sandbox → orchestrator (the workspace).** Whatever the agent wrote is hostile data. It is read by the checker and never executed on the server.
6. **Orchestrator → GitHub.** Git runs with a deploy key scoped to one repository and a pinned host key.
7. **Orchestrator → database gateway → database.** The gateway holds the one database login. After the checker has passed an app, the orchestrator hands the gateway the changes it wrote down for that job, and the gateway turns them into statements. Nobody sends it SQL.
8. **Published app → visitor.** The app runs in the visitor's browser under a policy the agent cannot change.
9. **Published app → database.** A page of an app with tables talks to the database's Data API from the visitor's browser, with a public key and the rights of an anonymous visitor.
10. **Published app → this API → two public sources.** A page of an app with live data asks this API for the weather or for exchange rates. The API asks the source and writes its own answer.

## Threats and controls

### The hijacked agent tries to act on the server

- It has no tool that executes anything. Claude Code runs with `--restricted`, a fixed list of file tools and one fixed MCP server, the database gateway, all set in the image's entrypoint.
- File tools are confined to the workspace. Even without that, the container's root filesystem is read-only and holds nothing of value.
- The container runs as an unprivileged user with all capabilities dropped, `no-new-privileges`, and limits on memory, CPU and process count.
- The sandbox network is an internal Docker network without a host-side gateway address. From inside, the internet, the host's own services and the cloud metadata address are unreachable; the key proxy and the database gateway are the only addresses that answer. This was verified by probing from a container, and the first version failed that probe: the host's SSH port answered on the bridge gateway until the gateway was removed. Two job containers can be alive at the same time and share this network, so at the network level one can address the other. Each has its own workspace and tokens bound to its own job, and the agent's tools (files, and the three of the database gateway) give it no way to open a connection of its choosing. That a job container does not answer another one has not been probed.
- A job that exceeds its time limit is killed, and the container is removed after every job.

### The hijacked agent tries to steal or abuse the API key

- The key is not in the container. The agent holds a token of the form `pgj1.<job>.<expiry>.<hmac>` that only the proxy accepts and that expires with the job.
- If the agent writes that token, or its token for the database gateway, into the app, the checker rejects the app. Outside the server the token is useless anyway: the proxy listens on the sandbox network and on the host's loopback address (for the prompt screen), and nowhere else.
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

HTML that passes is parsed and written out again with three additions at the very top of `<head>`: a Content Security Policy, a job marker and a no-referrer policy. A badge marking the page as AI-generated is appended to `<body>`. An existing policy from the agent is dropped, and so is every meta tag that carries one of the checker's own names.

The policy is the actual enforcement. With `connect-src 'none'`, `form-action 'none'` and `script-src 'self'`, a page cannot send requests anywhere or load code from elsewhere, whatever its scripts try. The checks before it exist so that a rejected app fails loudly with a reason instead of being published broken.

Two kinds of page get a wider policy, each by one path. A page that loads the database library, in an app that has tables, may reach the Data API of the database. A page that loads the live data library may reach the live data routes of this API. What each opens up is described under "Data in an app's tables" and "Live data".

### The attacker targets the pipeline itself

- **Command injection.** The prompt is never part of a command line, a path or a commit message. Subprocesses (`sudo`, `git`) are started with argument arrays. The only request-derived value used in paths is the job id, which the server generates from random bytes.
- **Path tricks in the workspace.** Symlinks, special files, dotfiles, odd names and deep nesting are rejected before any content is read. Output paths are built from names that passed a strict pattern.
- **Tampering with bundled libraries.** The agent's copy of `lib/` is ignored. Referenced libraries are published from the pristine copies on the server.
- **Leaking internals through errors.** Visitors see fixed messages. Details go to the server log.

### The attacker targets the budget or the service

- Turnstile in front of job creation, verified on the server.
- Three jobs per visitor per hour (IPv6 visitors are counted per /64, logged-in visitors by account as well), ten per hour and thirty per day overall, a queue of ten.
- At most two jobs at a time, each with a hard timeout and a budget in tokens and dollars.
- The orchestrator stores what each job cost, as the proxy counted it, and turns new jobs away once a visitor's day, the day or the last 30 days have used their budget. The cost of a job is known when it ends, so jobs already waiting can overshoot a budget, each by at most the cap for one job.
- A prompt screen in front of the queue. After the captcha and the limits, the orchestrator asks a small model (Claude Haiku 5.5) whether the text is a request for an app, gibberish, abusive, or carries personal data of a private person, and turns the last three away with a fixed message. The call goes through the key proxy with a 30-second job token, so the orchestrator still never holds the API key and the proxy's vetting and logging apply.
- The screen is not a security control and nothing depends on it. The visitor's text is passed as data, the answer is constrained to four fixed values, and a prompt that talks the model into "ok" gets what every prompt gets: the sandbox and the checker. If the call fails or times out, the request is let through. The same goes for personal data: what the screen misses is built and published like any other text, which is why the rules of the site forbid sending it.
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
- An account that is not used is not kept. A job that runs inside the database once a day deletes every account whose last login is more than 90 days ago and whose sessions have not been renewed since. It runs there because nothing outside the database holds a key to the accounts.
- Anyone can ask for a login mail to any address. The form is behind a captcha that Supabase checks, and Supabase limits how often mail goes out, in total and per address.

### The hijacked agent goes for the database

Apps can keep data that their visitors share, in tables of the Supabase project that also holds the accounts. The agent never touches that database.

- **The agent can only ask.** It has three tools, served by a gateway over MCP: list the app's tables, ask for a table, ask for a column. The tools check the wish against fixed rules and write it down. They run no statement that changes anything. A job gets 60 calls and 40 wishes.
- **Nothing is created before the checker has passed the app.** When the agent is done, the orchestrator fetches what the gateway wrote down for the job, runs the checker, and only then has the gateway apply the list, in one transaction. A rejected app leaves nothing in the database. Wishes can only add tables and columns, so the version of an app that is online keeps working whatever happens to a later job.
- **No SQL comes from outside.** The gateway builds every statement itself. A name must match a strict pattern before it is quoted, types and access modes come from fixed lists, and a refusal never repeats the input that failed. A wish holds no free text at all, which is why there is nothing in it to scan for secrets.
- **A job's pass opens its own app only.** The sandbox gets a token of the form `agd1.<app>.<job>.<expiry>.<hmac>`, signed with a secret that is the gateway's own. The launcher checks that it belongs to the job it starts; the gateway checks signature and expiry and takes the app from the token, never from the request. Written into the app, it gets the app rejected. The gateway's other routes, for the orchestrator, are on the same port and need a different pass that no sandbox ever holds.
- **The gateway's role cannot get at the accounts.** It is a member of no other role and has rights on one schema, `apps`, which holds nothing but the apps' tables. Tried on the project with a role of the same making: `auth`, `storage`, the vault, other roles' passwords, files and programs on the database server are all refused.
- **The gateway checks its own role.** Before it does any work it asks the database what its role is and what it may use. If the role has gained a special power, a membership or a schema it has no business in, the gateway refuses to work until it is restarted. Its statements are only as harmless as the role that runs them.
- **The password never left the server in the clear.** The server makes it. The database is given a SCRAM verifier of it, which is what Postgres stores anyway; the statement that sets it can sit in an editor's history or a log without giving the password away. The connection is encrypted and checked against Supabase's certificate authority.
- **Without the database, apps are built without it.** A gateway that is down or cannot reach the database offers no tools, and the agent is told to keep data in the browser then. Only a change to an app that already has tables needs the database, and fails early with a fixed message when it is not there.

What remains: the gateway's role can create any kind of object in `apps`, not only tables. It can also install the extensions Supabase offers, because Supabase lets every database role do that, and some of those make requests from the database server. It can fill the database, which would stop logins as well, since both live in one project. None of this is within reach of a visitor or an agent. It would take control of the gateway itself, whose input is a short list of names and types.

### Data in an app's tables

- **It is public.** A visitor's browser talks to the database's Data API with a public key, as the anonymous role. Every visitor can read all rows of a table and add rows. In a table that was asked for as `shared`, every visitor can also change and delete any row. A visitor can never set a row's id or its timestamps. A page that can reach the database carries a notice: "Anything entered here is public."
- **Rights are fixed when a table is created.** Row level security is on, and each right is given twice, as a grant and as a policy, to the anonymous role only. A logged-in account of this site gets nothing. The Data API exposes the one schema with the apps' tables; the accounts are not behind it.
- **Space is capped in the database.** A trigger refuses the 501st row of a table and any row over 2 kB, also when many rows arrive in one request. An app gets three tables with twelve columns each, all apps together 150 tables.
- **Tables go when their app goes.** Once an hour the orchestrator sends the list of live apps, and the gateway drops every table of its own that belongs to none of them. Tables it did not make are never touched.
- **Only a page that loads the database library is let through.** The checker writes the address, the public key and the app's table prefix into a meta tag of that page and widens its policy by the Data API path. The agent's code holds no address. Every other page of the same app stays closed.
- **Rows are written by strangers.** An app that put them into the page as HTML would show the next visitor whatever markup a stranger stored. The checker rejects `innerHTML` and its relatives in the scripts of an app with tables. That catches the honest mistake; a script that is out to do it can hide the name. Scripts inside such markup stay blocked by the policy either way.
- **An open page asks little.** The library asks whether anything changed with a request of a few hundred bytes, less and less often while nothing does, and not at all in a hidden tab. It reads the rows again only after a change.

What remains, and is the price of apps that share data:

- **A page can keep what a visitor types.** Without tables, a page had nowhere to send it. A page with tables can store it where its author, and everyone else, can read it. The notice says so, but the agent's own styles could cover it. What stands against abuse is that the data is public rather than private to an attacker, that the checker still rejects password and card fields, that apps live for one or ten days, and that removing an app removes its tables.
- **Anyone can write to any app's table.** The public key is in every such page, and the table names are in the public apps repository. Someone can fill a guestbook with rubbish up to its cap, or wipe a shared list. Apps are demos; nothing in them is worth more than that.
- **Reading costs the project, not the reader.** Someone who reads tables in a loop can use up the free plan's transfer quota. Logins live in the same project and would stop with it. Builds without an account never depend on it.

### Live data

A published app can show the weather and exchange rates. It never reaches the sources. It asks this API, which answers four fixed questions: the weather at a position, places by name, today's rates of a currency, and one rate over time.

- **Nothing is passed through.** Each question has typed parameters: a position as two bounded decimal numbers, a currency from a list of thirty, a number of days, the name of a place. The API builds the upstream address itself, for two fixed hosts, follows no redirect, waits five seconds at most and reads 200 kB at most.
- **Answers are rebuilt, not forwarded.** The API takes the fields it expects from an answer, checks each for its type, and writes its own response. Whatever else a source might send, by mistake or after being taken over, stays behind.
- **Only a page that loads the live data library is let through, and only to these routes.** The checker writes their address into a meta tag; the agent's code holds none. The rest of this API is out of such a page's reach twice over: the page's policy does not allow the request, and the API answers the apps' origin on these routes only.
- **The routes are public, so they are limited.** An address gets 60 requests a minute. Answers are kept in memory for as long as they are good (the weather ten minutes, rates an hour, a place a day). What is not in memory counts against a daily allowance, per visitor and overall, so that one caller cannot use up what the sources give away.
- **Little of the visitor goes anywhere.** A position is rounded to about a kilometre before it leaves, the visitor's address never leaves, and the request log holds neither a position nor a place.
- **The sources are named on the page.** The checker adds the credit they ask for to the badge of every page that can ask for live data.

What remains: the name of a place is free text. A page that is out to do it could send what a visitor typed, sixty characters at a time, as a place to look up. It would reach this server's memory and the weather service, and nobody who could read it back. And whoever uses up the daily allowance from many addresses switches live data off for everyone until the next day; apps then show a message.

## Known trade-offs

- **The launcher runs as root.** The orchestrator has no access to the Docker socket. It may run one root-owned script through sudo, `ag-sandbox run|kill <job-id>`, which validates the id and the job token and then starts a container whose every other setting is fixed in the script and a root-owned config file. A bug in that script would be serious, so it is short and tested. The price is that the service cannot use `NoNewPrivileges` and the systemd options that imply it.
- **Navigation cannot be blocked.** No browser policy stops a script from redirecting the top-level page. The checker rejects scripts that contain external URLs, but an obfuscated one would pass. The page could then send the visitor to another site, and carry along in the address what the visitor typed before. The policy stops requests in the background; it cannot stop the page from leaving.
- **Shared origin on github.io.** All published apps share one origin with each other and with other project pages of the same account. They can read each other's local storage. Nothing sensitive may ever be hosted on that origin.
- **One Supabase project for accounts and app data.** The free plan allows two projects and the other one is taken. The two kinds of data are kept apart inside the database, by schema and by role, but they share its quotas: what exhausts the project stops both.
- **The checker is not a content filter.** It enforces what a page can do, not what it says. Offensive text passes. The badge, the captcha and the ability to delete an app are the answer to that.
- **Policy as a meta tag.** GitHub Pages cannot send response headers, so the policy is delivered in the document. `frame-ancestors` is not available that way, so apps can be framed by other sites.
