# `.github/workflows/`

| Workflow | Triggers | Purpose |
|---|---|---|
| `release.yml` | push of a tag matching `*.*.*`, or `workflow_dispatch` | Full release gate: governance file checks -> quality (`ci:check` + coverage + `npm pack` check) -> security (Trivy + Gitleaks) -> SonarQube (skips cleanly if unconfigured) -> publish to npm with provenance + create a GitHub release. All four gate jobs must pass before `publish` runs |
| `pr-quality.yml` | push/PR to `main`, or `workflow_dispatch` | Lint, typecheck, test (with coverage), build + `npm pack` check, optional SonarQube |
| `pr-security.yml` | push/PR to `main`, or `workflow_dispatch` | Trivy filesystem scan + Gitleaks secret scan, both uploaded as SARIF to the Security tab |
| `pr-governance.yml` | push/PR to `main`, or `workflow_dispatch` | On pull requests: enforces `<type>/<desc>` branch naming and Conventional Commits PR titles, and requires CODEOWNERS coverage for changes touching workflows/CODEOWNERS/SECURITY.md/.gitleaks.toml |

**`release.yml` reads its version from `github.ref_name`, not from an
input.** It validates that ref against `^[0-9]+\.[0-9]+\.[0-9]+$` — bare
semver, e.g. `1.0.0`, no `v` prefix. That means:

- The normal path is a tag push: `git tag 1.0.0 && git push origin 1.0.0`.
- If you dispatch it manually instead, you **must** pass `--ref <tag>`
  pointing at an existing bare-semver tag — `--ref main` (or any branch)
  will always fail the "Validate release tag format" step, since
  `github.ref_name` will resolve to the branch name instead of a version.

## Required repo secrets

| Secret | Used by | Notes |
|---|---|---|
| `NPM_TOKEN` | `release.yml` (`publish` job) | npm automation token with publish rights for the `@openbox-ai/openbox-sdk-ts` package (scoped — the token's account needs publish rights in the `openbox-ai` npm org). Create at npmjs.com -> Access Tokens -> Generate New Token -> Automation, then `gh secret set NPM_TOKEN --repo OpenBox-AI/openbox-sdk-ts` |
| `SONAR_TOKEN`, `SONAR_HOST_URL` | `release.yml`, `pr-quality.yml` | Optional. SonarQube/SonarCloud steps skip cleanly (no failure) when either is unset. `sonar-project.properties` ships with a placeholder `projectKey` — update it to your real project key once you have one |
| `CODECOV_TOKEN` | `pr-quality.yml` | Optional. Codecov upload step only runs when this is set and coverage was produced |

`release.yml`'s `publish` job also runs under a `release` GitHub
Environment — configure required reviewers there (Settings -> Environments
-> release) if you want a manual approval gate before npm publish.

## Required GitHub variable

`pr-governance.yml`'s commit-message check only runs when the repo variable
`ENFORCE_COMMIT_CONVENTION` is set to `true` (Settings -> Secrets and
variables -> Actions -> Variables). Unset by default.

Not present: this repo has no TypeSpec/OpenAPI spec system or upstream
service to drift-check, so there's no `codegen.yml` or `spec-drift.yml`
equivalent — those only make sense for spec-driven SDKs. There is also no
"pinnable git branch" release mechanism (no `release-branch.yml`) — `main`
tags are the only release artifact; installing from source or from the npm
registry are the two supported paths.

Unit tests live in `test/` and run via `npm run test` / `npm run ci:check`;
nothing in CI needs live OpenBox Core credentials.

## How to run a workflow manually

GitHub UI: Actions tab, pick the workflow, "Run workflow", choose a
branch.

Via `gh`:

```bash
gh workflow run pr-quality.yml       --ref main
gh workflow run pr-security.yml      --ref main
gh workflow run pr-governance.yml    --ref main
```

`release.yml` is the exception — see above. Don't dispatch it against a
branch; either push a tag (recommended) or dispatch with `--ref <tag>`:

```bash
git tag 1.0.0
git push origin 1.0.0
# or, to re-run against an existing tag without pushing a new one:
gh workflow run release.yml --ref 1.0.0
```
