# CLI Reference

Workcell CLI now supports both:

- instance setup/diagnostics (`onboard`, `doctor`, `configure`, `env`, `allowed-hostname`, `env-lab`)
- control-plane client operations (issues, approvals, agents, activity, dashboard)

## Base Usage

Use repo script in development:

```sh
pnpm workcell --help
```

First-time local bootstrap + run:

```sh
pnpm workcell run
```

Choose local instance:

```sh
pnpm workcell run --instance dev
```

## Deployment Modes

Mode taxonomy and design intent are documented in `doc/DEPLOYMENT-MODES.md`.

Current CLI behavior:

- `workcell onboard` and `workcell configure --section server` set deployment mode in config
- server onboarding/configure ask for reachability intent and write `server.bind`
- `workcell run --bind <loopback|lan|tailnet>` passes a quickstart bind preset into first-run onboarding when config is missing
- runtime can override mode with `WORKCELL_DEPLOYMENT_MODE`
- `workcell run` and `workcell doctor` still do not expose a direct low-level `--mode` flag

Canonical behavior is documented in `doc/DEPLOYMENT-MODES.md`.

Allow an authenticated/private hostname (for example custom Tailscale DNS):

```sh
pnpm workcell allowed-hostname dotta-macbook-pro
```

Bring up the default local SSH fixture for environment testing:

```sh
pnpm workcell env-lab up
pnpm workcell env-lab doctor
pnpm workcell env-lab status --json
pnpm workcell env-lab down
```

All client commands support:

- `--data-dir <path>`
- `--api-base <url>`
- `--api-key <token>`
- `--context <path>`
- `--profile <name>`
- `--json`

Company-scoped commands also support `--company-id <id>`.

Use `--data-dir` on any CLI command to isolate all default local state (config/context/db/logs/storage/secrets) away from `~/.workcell`:

```sh
pnpm workcell run --data-dir ./tmp/workcell-dev
pnpm workcell issue list --data-dir ./tmp/workcell-dev
```

## Context Profiles

Store local defaults in `~/.workcell/context.json`:

```sh
pnpm workcell context set --api-base http://localhost:3100 --company-id <company-id>
pnpm workcell context show
pnpm workcell context list
pnpm workcell context use default
```

To avoid storing secrets in context, set `apiKeyEnvVarName` and keep the key in env:

```sh
pnpm workcell context set --api-key-env-var-name WORKCELL_API_KEY
export WORKCELL_API_KEY=...
```

## Company Commands

```sh
pnpm workcell company list
pnpm workcell company get <company-id>
pnpm workcell company delete <company-id-or-prefix> --yes --confirm <same-id-or-prefix>
```

Examples:

```sh
pnpm workcell company delete PAP --yes --confirm PAP
pnpm workcell company delete 5cbe79ee-acb3-4597-896e-7662742593cd --yes --confirm 5cbe79ee-acb3-4597-896e-7662742593cd
```

Notes:

- Deletion is server-gated by `WORKCELL_ENABLE_COMPANY_DELETION`.
- With agent authentication, company deletion is company-scoped. Use the current company ID/prefix (for example via `--company-id` or `WORKCELL_COMPANY_ID`), not another company.

## Issue Commands

```sh
pnpm workcell issue list --company-id <company-id> [--status todo,in_progress] [--assignee-agent-id <agent-id>] [--match text]
pnpm workcell issue get <issue-id-or-identifier>
pnpm workcell issue create --company-id <company-id> --title "..." [--description "..."] [--status todo] [--priority high]
pnpm workcell issue update <issue-id> [--status in_progress] [--comment "..."]
pnpm workcell issue comment <issue-id> --body "..." [--reopen]
pnpm workcell issue checkout <issue-id> --agent-id <agent-id> [--expected-statuses todo,backlog,blocked]
pnpm workcell issue release <issue-id>
```

## Agent Commands

```sh
pnpm workcell agent list --company-id <company-id>
pnpm workcell agent get <agent-id>
pnpm workcell agent local-cli <agent-id-or-shortname> --company-id <company-id>
```

`agent local-cli` is the quickest way to run local Claude/Codex manually as a Workcell agent:

- creates a new long-lived agent API key
- installs missing Workcell skills into `~/.codex/skills` and `~/.claude/skills`
- prints `export ...` lines for `WORKCELL_API_URL`, `WORKCELL_COMPANY_ID`, `WORKCELL_AGENT_ID`, and `WORKCELL_API_KEY`

Example for shortname-based local setup:

```sh
pnpm workcell agent local-cli codexcoder --company-id <company-id>
pnpm workcell agent local-cli claudecoder --company-id <company-id>
```

## Secrets Commands

```sh
pnpm workcell secrets list --company-id <company-id>
pnpm workcell secrets declarations --company-id <company-id> [--include agents,projects] [--kind secret]
pnpm workcell secrets create --company-id <company-id> --name anthropic-api-key --value-env ANTHROPIC_API_KEY
pnpm workcell secrets link --company-id <company-id> --name prod-stripe-key --provider aws_secrets_manager --external-ref <provider-ref>
pnpm workcell secrets doctor --company-id <company-id>
pnpm workcell secrets migrate-inline-env --company-id <company-id> [--apply]
```

Secret listing and declarations never print secret values. `create` accepts
`--value-env` so shell history does not capture the value. `link` records
provider-owned references without copying the secret value into Workcell.
For AWS-backed secrets, `secrets doctor` reports missing non-secret provider
env and the expected AWS SDK runtime credential source; do not store AWS
bootstrap credentials in Workcell secrets.

Per-company provider vaults (multiple vault instances per provider, default
vault selection, coming-soon GCP/Vault) are configured from the board UI under
`Company Settings → Secrets → Provider vaults` or through
`/api/companies/{companyId}/secret-provider-configs`. There is no CLI surface
for vault management today. See the
[secrets deploy guide](../docs/deploy/secrets.md#provider-vaults) and
[API reference](../docs/api/secrets.md#provider-vaults) for the contract.

## Approval Commands

```sh
pnpm workcell approval list --company-id <company-id> [--status pending]
pnpm workcell approval get <approval-id>
pnpm workcell approval create --company-id <company-id> --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]
pnpm workcell approval approve <approval-id> [--decision-note "..."]
pnpm workcell approval reject <approval-id> [--decision-note "..."]
pnpm workcell approval request-revision <approval-id> [--decision-note "..."]
pnpm workcell approval resubmit <approval-id> [--payload '{"...":"..."}']
pnpm workcell approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm workcell activity list --company-id <company-id> [--agent-id <agent-id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard Commands

```sh
pnpm workcell dashboard get --company-id <company-id>
```

## Heartbeat Command

`heartbeat run` now also supports context/api-key options and uses the shared client stack:

```sh
pnpm workcell heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100] [--api-key <token>]
```

## Local Storage Defaults

Local Workcell data lives under the selected instance root. `WORKCELL_HOME` chooses the home directory and `WORKCELL_INSTANCE_ID` chooses the instance.

```text
~/.workcell/                                     # WORKCELL_HOME
└── instances/
    └── default/                                  # instance root (WORKCELL_INSTANCE_ID)
        ├── config.json                           # runtime config
        ├── .env                                  # instance env file
        ├── db/                                   # embedded PostgreSQL data
        ├── data/
        │   ├── storage/                          # local_disk uploads
        │   └── backups/                          # automatic DB backups
        ├── logs/
        ├── secrets/
        │   └── master.key                        # local_encrypted master key
        ├── workspaces/                           # default agent workspaces
        ├── projects/                             # project execution workspaces
        ├── companies/                            # per-company adapter homes (e.g. codex-home)
        └── codex-home/                           # per-instance codex home (when not company-scoped)
```

Default paths for the canonical install:

- config: `~/.workcell/instances/default/config.json`
- embedded db: `~/.workcell/instances/default/db`
- logs: `~/.workcell/instances/default/logs`
- storage: `~/.workcell/instances/default/data/storage`
- secrets key: `~/.workcell/instances/default/secrets/master.key`

Override base home or instance with env vars:

```sh
WORKCELL_HOME=/custom/home WORKCELL_INSTANCE_ID=dev pnpm workcell run
```

## Storage Configuration

Configure storage provider and settings:

```sh
pnpm workcell configure --section storage
```

Supported providers:

- `local_disk` (default; local single-user installs)
- `s3` (S3-compatible object storage)
