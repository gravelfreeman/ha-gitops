# Home Assistant GitOps

This repository contains the Home Assistant configuration and resources that I
create and want to keep under version control.

The Kubernetes deployment pulls this repository into the live Home Assistant
configuration. The repository is intentionally limited to authored
configuration. Runtime state, vendor-managed files, HACS resources, databases,
and secrets remain on the persistent volume or in the Kubernetes secret
management workflow.

## Why this design

Home Assistant is not a fully declarative application. It creates and updates
many files while running, and integrations and HACS components also manage
parts of the configuration tree. Treating every file under `/config` as
Git-owned would create unnecessary conflicts and require a large controller to
continuously reconcile two different owners.

I also do not want to version files that I did not create when those files are
already covered by the Home Assistant PVC backup. The `ha-gitops` repository
therefore represents the configuration and resources I intentionally create.
Over time, it becomes an auditable map of the Home Assistant setup without
pretending that every runtime artifact is declarative.

The implementation uses existing, easy-to-audit components:

- GitHub as the source of truth.
- `git-sync` as the Kubernetes sidecar that polls and publishes the repository.
- One small shell exechook.
- The Home Assistant configuration-check and reload APIs.

This avoids a custom Home Assistant add-on or a heavy controller for a problem
that can be handled by a small amount of glue code.

## Repository scope

The `app/` directory is the Git-owned part of the Home Assistant configuration:

```text
app/
├── configuration.yaml
├── configuration/
└── www/
    ├── lovelace/
    │   └── tabs.js
    └── streamline-card/
        └── streamline_templates.yaml
```

The following remain outside this repository:

- Home Assistant runtime state and `.storage/`.
- HACS-managed integrations and frontend resources.
- `/config/www/community/` and other vendor-managed directories.
- Databases and other generated runtime data.
- Secrets and credentials.

The rule is simple: Git-owned files and runtime-owned files can share a real
parent directory, but the same file path must have one owner. For example,
Git can manage `www/lovelace/tabs.js` while HACS continues to manage
`www/community/`.

## End-to-end workflow

The Kubernetes deployment is defined separately in
[k8s-gitops](https://github.com/gravelfreeman/k8s-gitops). Its
[Home Assistant HelmRelease](https://github.com/gravelfreeman/k8s-gitops/blob/main/kubernetes/apps/domotics/home-assistant/app/helmrelease.yaml)
runs Home Assistant and `git-sync` as containers in the same Pod.

### 1. git-sync polls this repository

The `git-sync` sidecar pulls the `main` branch into:

```text
/config/.git-sync/
└── ha-gitops -> current git-sync worktree
```

The deployment uses sparse checkout so only `app/` is needed. The polling
interval is the `git-sync` default of 10 seconds. It only fetches and
publishes a new revision when the remote reference changes.

git-sync publishes revisions by switching its own checkout symlink after the
new worktree is ready. This gives the sidecar an atomic checkout boundary:
the hook never reads a partially checked-out revision.

### 2. git-sync runs the exechook

After publishing a new revision, `git-sync` runs the
[exechook.sh](https://github.com/gravelfreeman/k8s-gitops/blob/main/kubernetes/apps/domotics/home-assistant/app/resources/exechook.sh)
from the `git-sync` container.

This is important: the hook is not a process in the Home Assistant container.
It is mounted and executed by the `git-sync` sidecar, so its output is
visible in the `git-sync` container logs.

The hook receives the synchronized commit through `GITSYNC_HASH`. The
exechook is idempotent because git-sync may invoke it more than once for the
same revision, including during startup.

### 3. The hook projects Git files into /config

git-sync's checkout is not used as Home Assistant's live configuration
directory. The hook projects each file below `app/` to the matching path below
`/config`:

```text
/config/.git-sync/ha-gitops/app/configuration.yaml
        -> /config/configuration.yaml

/config/.git-sync/ha-gitops/app/configuration/...
        -> /config/configuration/...

/config/.git-sync/ha-gitops/app/www/...
        -> /config/www/...
```

Only files are symlinked. Destination directories remain real directories.
This is what allows Git-owned files and runtime-owned files to coexist without
putting HACS content into the Git checkout.

For every synchronization, the hook:

1. Removes stale symlinks whose Git source file was deleted.
2. Removes an empty parent directory only after removing its last stale Git
   symlink.
3. Creates missing destination directories.
4. Creates or replaces Git-owned file symlinks.
5. Refuses to replace an existing real directory with a file symlink.
6. Calls Home Assistant's configuration-check API.
7. Calls `homeassistant.reload_all` only when the configuration is valid.

A regular directory is never recursively deleted by the hook. This protects
directories such as `/config/www/community/` even if they contain many HACS
files and subdirectories.

### 4. Home Assistant validates and reloads

Once the file projection is complete, the hook calls:

```text
POST /api/config/core/check_config
POST /api/services/homeassistant/reload_all
```

A failed API request or rejected configuration is written to the
`git-sync` container log. The repository sync itself remains available, and
the next commit can be used to correct the configuration.

The Home Assistant API token is injected by Kubernetes from a secret. It is
never stored in this repository.

## The exechook

The current hook is maintained in
[k8s-gitops](https://github.com/gravelfreeman/k8s-gitops), not in this
repository:

- [Current exechook](https://github.com/gravelfreeman/k8s-gitops/blob/main/kubernetes/apps/domotics/home-assistant/app/resources/exechook.sh)
- [git-sync sparse-checkout](https://github.com/gravelfreeman/k8s-gitops/blob/main/kubernetes/apps/domotics/home-assistant/app/resources/sparse-checkout)
- [Home Assistant HelmRelease](https://github.com/gravelfreeman/k8s-gitops/blob/main/kubernetes/apps/domotics/home-assistant/app/helmrelease.yaml)
- [ExternalSecret definition](https://github.com/gravelfreeman/k8s-gitops/blob/main/kubernetes/apps/domotics/home-assistant/app/externalsecret.yaml)

The paths and endpoint can be adapted at the top of the script for another
environment:

```sh
root=/config
checkout=$root/.git-sync/ha-gitops
source_root=$checkout/app
token_file=/run/secrets/git-sync-secret/HOME_ASSISTANT_API_TOKEN_GIT_SYNC
ha_url=http://127.0.0.1:8123
```

The relative `app/` layout is part of the contract between this repository,
git-sync, and the hook. If those paths are changed, update the corresponding
git-sync and Kubernetes mounts as well.

The hook supports a dry-run mode. In the HelmRelease, enable it by
adding the environment variable to the `git-sync` container:

```yaml
env:
  HA_GITOPS_DRY_RUN: '1'
```

The hook can also be run manually:

```sh
/usr/bin/bash /etc/git-sync/exechook.sh --dry-run
```

Dry-run reports files that would be created or replaced and blocks unsafe
directory conflicts without changing the PVC or calling the Home Assistant
API. Remove `HA_GITOPS_DRY_RUN` from the HelmRelease to enable normal
projection and Home Assistant validation/reload.

The `git-sync` container emits structured JSON logs. To display only the
exechook output, including the dry-run result:

```sh
kubectl logs -n home-assistant deploy/home-assistant -c git-sync \
  | jq -Rr 'fromjson? | select(.logger == "exechook") | .stderr // empty'
```

## Kubernetes and security model

The two repositories have separate responsibilities:

| Repository | Responsibility |
| --- | --- |
| [ha-gitops](https://github.com/gravelfreeman/ha-gitops) | Authored Home Assistant configuration and resources under `app/` |
| [k8s-gitops](https://github.com/gravelfreeman/k8s-gitops) | Kubernetes workload, HelmRelease, PVC, mounts, ExternalSecrets, networking, and security policy |

The workload is designed for a restricted namespace:

- Home Assistant and `git-sync` run as non-root UID/GID 568.
- The Pod uses the default seccomp profile.
- Privilege escalation is disabled.
- Linux capabilities are dropped.
- The root filesystem is read-only.
- The deployment uses one `git-sync` sidecar; no second controller sidecar is
  required.
- The shared PVC is the boundary through which the sidecar projects files for
  Home Assistant.

The sidecar does not need Kubernetes API access. Its job is limited to pulling
the repository, running the mounted hook, and calling Home Assistant over the
local Pod network.

## Why not Flux for this loop?

Flux already manages the Kubernetes side of the system, so it remains the
right tool for deploying the HelmRelease, secrets, PVC, and other cluster
resources.

I deliberately do not use Flux as the inner loop for Home Assistant files.
That workflow would require waiting for a Flux reconciliation or adding a hook
to trigger one. It would enter the broader cluster reconciliation pipeline
for a change that only concerns one running application. It is slower and less
direct for a configuration change that should be visible quickly.

`git-sync` instead polls this repository every 10 seconds, updates only the
Home Assistant workload's shared PVC, and runs the exechook immediately after
the new revision is available. Flux remains responsible for the platform and
application deployment; git-sync handles the fast configuration loop inside
that already-deployed application.

## Reproducible development and AI access

The Kubernetes repository includes a
[devcontainer](https://github.com/gravelfreeman/k8s-gitops/tree/main/.devcontainer)
used as a reproducible development environment.

The goal is to use the same environment from Zed or VS Code when working with
an AI agent. The agent can be sandboxed with access to the GitOps repository
and the Home Assistant MCP server, while deployment access remains outside its
permissions. This gives the agent enough access to inspect and update
Home Assistant configuration, but not enough access to deploy arbitrary
changes to the Kubernetes cluster.

This separation provides:

- A reproducible toolchain.
- A clear boundary between configuration authoring and deployment.
- An auditable Git history for authored Home Assistant changes.
- A gated path for AI-assisted changes.
- A recovery path through the PVC backup for runtime state.

## Limitations

This is intentionally partial GitOps, not a claim that every byte of
`/config` is declarative.

- Runtime and HACS changes are not represented as commits here.
- A PVC backup is still required for complete Home Assistant recovery.
- The git-sync checkout is atomic, but the hook projects file symlinks one file
  at a time.
- A commit that creates an invalid Home Assistant configuration is still
  pulled; the API check prevents the reload and logs the error.
- A real directory conflict is blocked and must be resolved by changing the
  repository layout or the live data intentionally.

The trade-off is deliberate: the system keeps the authored part auditable and
easy to restore while leaving Home Assistant's mutable runtime data with the
component that owns it.
