# Security Policy

## Reporting a vulnerability

Please **do not** disclose security vulnerabilities in public issues. Use GitHub's private vulnerability reporting instead:

- Open this repository's **Security** tab and click **Report a vulnerability**.

Please include, where possible: the affected version or commit, steps to reproduce, the impact, and a suggested fix if you have one.

## Scope

This repository ships a lecture rendering engine and its tooling. The following are security issues and are welcome to report:

- XSS or HTML/Markdown injection in built output or front-end pages
- Credential leakage or path traversal in tooling scripts
- Overly broad permissions or supply-chain risks in CI workflows

## Supported versions

Only the latest commit on the `main` branch receives security fixes.

## Secrets and privacy

Do not include API keys, tokens, SSH private keys, or server addresses in commits, issues, or pull requests. CI runs a secret scan (`scripts/scan_secrets.py`) and reviews dependency changes on every pull request.
