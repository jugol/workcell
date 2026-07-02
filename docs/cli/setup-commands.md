---
title: Setup Commands
summary: Onboard, run, doctor, and configure
---

Instance setup and diagnostics commands.

## `workcell run`

One-command bootstrap and start:

```sh
pnpm workcell run
```

Does:

1. Auto-onboards if config is missing
2. Runs `workcell doctor` with repair enabled
3. Starts the server when checks pass

Choose a specific instance:

```sh
pnpm workcell run --instance dev
```

## `workcell onboard`

Interactive first-time setup:

```sh
pnpm workcell onboard
```

If Workcell is already configured, rerunning `onboard` keeps the existing config in place. Use `workcell configure` to change settings on an existing install.

First prompt:

1. `Quickstart` (recommended): local defaults (embedded database, no LLM provider, local disk storage, default secrets)
2. `Advanced setup`: full interactive configuration

Start immediately after onboarding:

```sh
pnpm workcell onboard --run
```

Non-interactive defaults + immediate start (opens browser on server listen):

```sh
pnpm workcell onboard --yes
```

On an existing install, `--yes` now preserves the current config and just starts Workcell with that setup.

## `workcell doctor`

Health checks with optional auto-repair:

```sh
pnpm workcell doctor
pnpm workcell doctor --repair
```

Validates:

- Server configuration
- Database connectivity
- Secrets adapter configuration, including AWS Secrets Manager non-secret env
  config when selected
- Storage configuration
- Missing key files

## `workcell configure`

Update configuration sections:

```sh
pnpm workcell configure --section server
pnpm workcell configure --section secrets
pnpm workcell configure --section storage
```

`--section secrets` updates the deployment-level provider used as the fallback
for secrets that do not target a specific company vault. Per-company provider
vaults (named instances, default vault selection, multiple vaults per provider,
coming-soon GCP/Vault) live in the board UI under
`Company Settings → Secrets → Provider vaults` and the
`/api/companies/{companyId}/secret-provider-configs` API.

## `workcell env`

Show resolved environment configuration:

```sh
pnpm workcell env
```

This now includes bind-oriented deployment settings such as `WORKCELL_BIND` and `WORKCELL_BIND_HOST` when configured.

## `workcell allowed-hostname`

Allow a private hostname for authenticated/private mode:

```sh
pnpm workcell allowed-hostname my-tailscale-host
```

## Local Storage Paths

| Data | Default Path |
|------|-------------|
| Config | `~/.workcell/instances/default/config.json` |
| Database | `~/.workcell/instances/default/db` |
| Logs | `~/.workcell/instances/default/logs` |
| Storage | `~/.workcell/instances/default/data/storage` |
| Secrets key | `~/.workcell/instances/default/secrets/master.key` |

Override with:

```sh
WORKCELL_HOME=/custom/home WORKCELL_INSTANCE_ID=dev pnpm workcell run
```

Or pass `--data-dir` directly on any command:

```sh
pnpm workcell run --data-dir ./tmp/workcell-dev
pnpm workcell doctor --data-dir ./tmp/workcell-dev
```
