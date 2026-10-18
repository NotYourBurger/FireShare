# Security policy

## Reporting a vulnerability

**Please don't open a public issue for security problems.**

Report it privately through GitHub: go to the [Security tab](https://github.com/NotYourBurger/FireShare/security/advisories/new) and choose **Report a vulnerability**. Include:

- what an attacker can do, and what they need to have first (a share link, the upload password, network access to the host…)
- the steps to reproduce it, and the FireShare version (`FIRESHARE_VERSION`, or the commit)
- any relevant settings from `.env`, **with secrets removed**

You'll get a reply within 7 days. Once a fix is released, the advisory is published with credit to you, unless you'd rather stay anonymous.

## Supported versions

FireShare is pre-1.0. Security fixes go into the newest release and into `main`. Please update to the newest release before you report a problem.

## Scope

In scope: the app, the cleanup worker, `storage-init`, the published images, and the default `compose.yaml` setup.

Out of scope, but worth telling us about: problems in Garage, PostgreSQL, Node.js or other dependencies. Please report those to their own projects too. Also out of scope: setups the docs warn about, such as plain HTTP, `ALLOW_INSECURE_DIRECT_ENDPOINT=true`, or public uploads without quotas.

[docs/security.md](docs/security.md) explains the security model and its known limits.
