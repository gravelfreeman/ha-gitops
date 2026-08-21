# Home Assistant GitOps

This repository contains the Home Assistant configuration and custom resources created for this installation.

The Kubernetes deployment synchronizes the `app/` directory into the live Home Assistant configuration. Runtime data, `.storage`, HACS-managed resources, themes, blueprints, and secrets remain outside this repository.

## Repository layout

```text
app/
├── configuration.yaml
├── configuration/
└── www/
    ├── lovelace/
    └── streamline-card/
```

Files outside `app/www/` are published as symlinks into the Home Assistant configuration.

## Web resources

Home Assistant does not serve static files correctly through symlinks. Every Git-managed file under `app/www/` must therefore start with an ownership marker matching its file syntax:

```js
// ha-gitops
```

```yaml
# ha-gitops
```

For example:

- [app/www/lovelace/tabs.js](https://github.com/gravelfreeman/ha-gitops/blob/main/app/www/lovelace/tabs.js)
- [app/www/streamline-card/streamline_templates.yaml](https://github.com/gravelfreeman/ha-gitops/blob/main/app/www/streamline-card/streamline_templates.yaml)

The marker tells the synchronization hook to copy the file into `/config/www/` instead of creating a symlink. It also allows the hook to remove stale copies when a marked file is deleted from Git, without touching unmarked runtime or HACS files.

Only files created and maintained by this repository belong under `app/www/`. Do not add HACS-managed resources or other Home Assistant runtime files here.
