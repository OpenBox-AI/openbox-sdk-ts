# Security Policy

## Supported Versions

Only the latest published release of `@openbox-ai/openbox-sdk-ts` receives
security fixes.

## Reporting a Vulnerability

Please report suspected security vulnerabilities privately using
[GitHub's private vulnerability reporting](https://github.com/OpenBox-AI/openbox-sdk-ts/security/advisories/new)
for this repository (Security tab -> "Report a vulnerability"). Do not open a
public issue for suspected vulnerabilities.

Include as much of the following as you can:

- A description of the vulnerability and its potential impact
- Steps to reproduce, or a minimal proof-of-concept
- The version of the SDK affected

We aim to acknowledge reports within 5 business days.

## Secrets

This SDK never logs or transmits `OPENBOX_API_KEY`, `OPENBOX_AGENT_PRIVATE_KEY`,
or other credentials outside of authenticated requests to the configured
`openboxUrl`. If you believe a credential has been exposed by this SDK,
please report it via the process above rather than a public issue.
