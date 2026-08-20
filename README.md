# Home Assistant GitOps

Version-controlled Home Assistant configuration consumed from the `app/` directory.

The `app/` tree is synchronized into the live Home Assistant configuration by the Kubernetes deployment. Runtime data, `.storage`, HACS-managed resources, themes, blueprints, and secrets remain outside this repository.
