# Contributing to Archivum Null

Thank you for considering a contribution to Archivum Null. This project handles **encrypted user files** and prioritises security above all else. Please read this guide fully before opening a pull request.

---

## Table of Contents

- [Contributing to Archivum Null](#contributing-to-archivum-null)
  - [Table of Contents](#table-of-contents)
  - [Before You Start](#before-you-start)
  - [Scope of Contributions](#scope-of-contributions)
  - [Development Setup](#development-setup)
    - [Requirements](#requirements)
    - [Local start (no Docker)](#local-start-no-docker)
    - [Environment variables](#environment-variables)
  - [Project Structure](#project-structure)
  - [Coding Guidelines](#coding-guidelines)
    - [General](#general)
    - [Linting](#linting)
    - [TypeScript](#typescript)
    - [Naming conventions](#naming-conventions)
    - [Dependencies](#dependencies)
    - [Commits](#commits)
  - [Testing Requirements](#testing-requirements)
    - [Run the full suite](#run-the-full-suite)
    - [Coverage](#coverage)
    - [What to test](#what-to-test)
    - [Test style](#test-style)
  - [Secure Contributing](#secure-contributing)
    - [Cryptography](#cryptography)
    - [Input handling](#input-handling)
    - [Dependencies](#dependencies-1)
    - [Secrets and credentials](#secrets-and-credentials)
    - [AI-assisted code](#ai-assisted-code)
    - [Pull request security checklist](#pull-request-security-checklist)
  - [Submitting Changes](#submitting-changes)
    - [PR description must include](#pr-description-must-include)
  - [Reporting Security Vulnerabilities](#reporting-security-vulnerabilities)

---

## Before You Start

- Check the [open issues](../../issues) and [pull requests](../../pulls) to avoid duplicating work.
- For large changes or new features, open an issue first to discuss the approach before investing time in code.
- By contributing, you agree to the project [License](LICENSE) and [Code of Conduct](CODE_OF_CONDUCT.md).

> **This project is beta software.** Architecture, API shape, and storage format may still change. Coordinate on the issue tracker before starting deep refactors.

---

## Scope of Contributions

Contributions that are **welcome**:

- Bug fixes (with a regression test)
- Security improvements or hardening
- Test coverage gaps
- Documentation corrections
- Performance improvements that do not trade off security
- Accessibility improvements in the frontend

Contributions we will **not accept**:

- Features that require storing user identity, emails, or plaintext content on the server
- Analytics, tracking, or telemetry of any kind
- Dependencies that introduce a server-side copy of the encryption key
- Weakening of existing rate limiting, size limits, or TTL clamping logic
- AI-generated code submitted without manual review and a test (see [Secure Contributing](#secure-contributing))

---

## Development Setup

### Requirements

| Tool | Version |
|---|---|
| Node.js | ≥ 24.0.0 |
| npm | bundled with Node.js |
| Docker & Docker Compose | optional — for containerised testing |

### Local start (no Docker)

```bash
# Backend
cd backend
npm install
npm run dev        # starts on http://localhost:3000

# Frontend (separate terminal)
cd frontend
npm install
npm run dev        # starts on https://localhost:5173
```

> Accept the self-signed certificate once in your browser — it is required for the WebCrypto API to work on `localhost`.

### Environment variables

Copy and adjust the example:

```bash
cp backend/.env.example backend/.env   # if present
```

The backend reads its config from environment variables. All variables and their defaults are documented in [`backend/src/config.ts`](backend/src/config.ts).

Security-sensitive variables (never commit these):

```
ADMIN_USER=
ADMIN_PASS=
TURNSTILE_SECRET=
TURNSTILE_HOSTNAME=
```

---

## Project Structure

```
backend/src/
  config.ts          # env-var parsing and validation
  index.ts           # Fastify app bootstrap
  middleware/        # auth, rate limiting, turnstile
  routes/            # HTTP route handlers
  storage/           # pluggable storage back-ends
  vault/             # vault manager and types
  __tests__/         # unit/integration tests (Vitest)

frontend/src/
  api/               # fetch wrappers
  components/        # reusable UI components
  crypto/            # client-side AES-256-GCM (WebCrypto)
  pages/             # route-level React pages
  __tests__/         # component and unit tests (Vitest + Testing Library)
```

---

## Coding Guidelines

### General

- **TypeScript** is mandatory everywhere — no `any` types and no type assertions without a comment explaining why.
- Keep functions small and single-purpose.
- No dead code or commented-out blocks in submitted PRs.
- Match the existing code style; ESLint is the source of truth.

### Linting

Both projects enforce zero warnings:

```bash
cd backend && npm run lint
cd frontend && npm run lint
```

Fix all lint errors before opening a PR. The CI gate is `eslint --max-warnings 0`.

### TypeScript

```bash
cd backend && npm run typecheck
cd frontend && npm run typecheck
```

No type errors are accepted.

### Naming conventions

| Context | Convention |
|---|---|
| Files | `camelCase.ts` / `PascalCase.tsx` for React components |
| Variables / functions | `camelCase` |
| Types / interfaces | `PascalCase` |
| Constants | `UPPER_SNAKE_CASE` |
| Environment variables | `UPPER_SNAKE_CASE` |

### Dependencies

- **Justify every new dependency** in the PR description.
- Prefer Node.js built-ins and already-present packages.
- Zero-dependency or small, auditable packages are strongly preferred.
- Do not add packages that phone home or include opt-out telemetry.
- Run `npm audit` before submitting — flag any findings in the PR.

### Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) style:

```
feat: add streaming progress indicator to upload
fix: prevent path traversal on vault ID with encoded slashes
docs: clarify TTL clamping behaviour in README
test: add coverage for oversized upload truncation
security: validate turnstile hostname before token verification
```

Keep commits focused — one logical change per commit. Avoid mixing refactors with feature changes in the same commit.

---

## Testing Requirements

**Every change must be covered by tests.** This is not optional.

### Run the full suite

```bash
cd backend && npm test
cd frontend && npm test
```

Both must pass **with zero failures** before submitting.

### Coverage

```bash
cd backend && npm run test:coverage
cd frontend && npm run test:coverage
```

New code should not decrease overall coverage. PRs that add testable logic without corresponding tests will be asked to add them.

### What to test

- **Bug fixes** — add a regression test that fails on the original code and passes on the fix.
- **New routes / handlers** — test success, validation failure, and error paths.
- **New frontend components** — test rendering, user interaction, and edge cases.
- **Security-critical paths** — test with boundary values, malformed input, and adversarial cases.

### Test style

- Use `describe` / `it` blocks with descriptive names.
- Prefer real logic over excessive mocking — mocks hide bugs.
- If you must mock, document why.

---

## Secure Contributing

Archivum Null is a security-sensitive project. The following rules apply strictly.

### Cryptography

- **Do not change or replace cryptographic primitives** without opening a dedicated security issue first.
- The key derivation, encryption scheme (AES-256-GCM, 256-bit key, 96-bit IV, URL fragment delivery) and zero-server-knowledge guarantee must be preserved.
- Do not introduce server-side access to the encryption key under any circumstances.

### Input handling

- All user-supplied input — file names, vault IDs, config values — must be validated and sanitised.
- Vault IDs are validated against `/^[a-zA-Z0-9_-]+$/` before any file system operation. Do not relax this pattern.
- Use parameterised logic; never build OS commands or paths by string concatenation.

### Dependencies

- Audit new dependencies before adding them: check for known CVEs, evaluate the maintainer track record, and review the source.
- Pin versions in `package.json` and verify the lockfile is committed.
- Remove the dependency if it is no longer needed — do not leave unused packages in the tree.

### Secrets and credentials

- **Never commit secrets**, credentials, tokens, or private keys — not in code, not in comments, not in test fixtures.
- Use environment variables for all secrets. The `.env` file is in `.gitignore`.
- If you accidentally commit a secret, treat it as compromised immediately and rotate it. Then open a private security report.

### AI-assisted code

This project was partially built with AI assistance. The same standard applies to all contributions:

- AI-generated code **must be reviewed line by line** before submission.
- Security-critical files (`crypto/encrypt.ts`, `middleware/basicAuth.ts`, `storage/local.ts`, vault expiry logic) must be reviewed with extra care.
- Do not submit AI output that you cannot explain and defend in a PR review.
- AI slop (plausible-looking but logically broken code) is a known risk — tests are the primary guard against it.

### Pull request security checklist

Before opening a PR that touches security-relevant code, confirm the following in your PR description:

```
- [ ] No plaintext file content is stored or logged server-side
- [ ] No encryption key leaves the client
- [ ] Vault ID input is validated before any filesystem operation
- [ ] No new unvalidated environment variable is introduced
- [ ] `npm audit` shows no new high/critical findings
- [ ] All tests pass (backend + frontend)
- [ ] ESLint passes with zero warnings (backend + frontend)
- [ ] TypeScript compiles with zero errors (backend + frontend)
```

---

## Submitting Changes

1. **Fork** the repository and create a branch from `dev` (not `main`).
2. Branch naming: `fix/short-description`, `feat/short-description`, `docs/short-description`, `security/short-description`.
3. Make your changes, following this guide.
4. Run the full test and lint suite.
5. Open a pull request against the `dev` branch.
6. Fill out the PR template completely — incomplete PRs will be asked to add missing information.
7. Respond to review comments. PRs that are not addressed within 30 days may be closed.

### PR description must include

- **What** changed and **why**.
- A reference to the related issue (`Closes #123` or `Relates to #123`).
- For security-related changes: the security checklist above.
- For dependency additions: justification and `npm audit` output.

---

## Reporting Security Vulnerabilities

**Do not open a public issue for security vulnerabilities.**

Follow the process in [SECURITY.md](SECURITY.md).
