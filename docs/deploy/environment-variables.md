---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that Workcell uses for server configuration.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `WORKCELL_BIND` | `loopback` | Reachability preset: `loopback`, `lan`, `tailnet`, or `custom` |
| `WORKCELL_BIND_HOST` | (unset) | Required when `WORKCELL_BIND=custom` |
| `HOST` | `127.0.0.1` | Legacy host override; prefer `WORKCELL_BIND` for new setups |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string |
| `WORKCELL_HOME` | `~/.workcell` | Base directory for all Workcell data |
| `WORKCELL_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `WORKCELL_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |
| `WORKCELL_DEPLOYMENT_EXPOSURE` | `private` | Exposure policy when deployment mode is `authenticated` |
| `WORKCELL_API_URL` | (auto-derived) | Workcell API base URL. When set externally (e.g., via Kubernetes ConfigMap, load balancer, or reverse proxy), the server preserves the value instead of deriving it from the listen host and port. Useful for deployments where the public-facing URL differs from the local bind address. |

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKCELL_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `WORKCELL_SECRETS_MASTER_KEY_FILE` | `~/.workcell/.../secrets/master.key` | Path to key file |
| `WORKCELL_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |

## Agent Runtime (Injected into agent processes)

These are set automatically by the server when invoking agents:

| Variable | Description |
|----------|-------------|
| `WORKCELL_AGENT_ID` | Agent's unique ID |
| `WORKCELL_COMPANY_ID` | Company ID |
| `WORKCELL_API_URL` | Workcell API base URL (inherits the server-level value; see Server Configuration above) |
| `WORKCELL_API_KEY` | Short-lived JWT for API auth |
| `WORKCELL_RUN_ID` | Current heartbeat run ID |
| `WORKCELL_TASK_ID` | Issue that triggered this wake |
| `WORKCELL_WAKE_REASON` | Wake trigger reason |
| `WORKCELL_WAKE_COMMENT_ID` | Comment that triggered this wake |
| `WORKCELL_APPROVAL_ID` | Resolved approval ID |
| `WORKCELL_APPROVAL_STATUS` | Approval decision |
| `WORKCELL_LINKED_ISSUE_IDS` | Comma-separated linked issue IDs |

## LLM Provider Keys (for adapters)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Local adapter) |
| `OPENAI_API_KEY` | OpenAI API key (for Codex Local adapter) |
