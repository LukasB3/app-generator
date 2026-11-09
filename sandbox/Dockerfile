# The disposable environment the coding agent runs in. It contains Claude Code
# and nothing else of value: no git, no credentials, no route to the internet.
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.289
RUN npm install --global @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/*

COPY system-prompt.md mcp.json /opt/agent/

ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    MCP_TIMEOUT=5000

USER node
WORKDIR /workspace

# The flags are fixed in the image so the orchestrator cannot be talked into
# loosening them: file tools only, no shell, no web, no settings files, and
# one MCP server, the database gateway. Its tools are the only ones allowed
# besides the file tools; without a valid token it offers none. A gateway that
# does not answer is given up on after MCP_TIMEOUT, so it cannot hold up a job.
ENTRYPOINT ["claude", "--print", "--restricted", \
  "--tools", "Read,Write,Edit,Glob,Grep", \
  "--permission-mode", "acceptEdits", \
  "--permission-prompts", "none", \
  "--strict-mcp-config", "--mcp-config", "/opt/agent/mcp.json", \
  "--allowedTools", "mcp__db__*", \
  "--setting-sources", "", \
  "--no-session-persistence", \
  "--output-format", "stream-json", "--verbose", \
  "--append-system-prompt-file", "/opt/agent/system-prompt.md"]
