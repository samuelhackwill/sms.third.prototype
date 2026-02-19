# SMS System - Third Prototype

Meteor + Blaze baseline project.

## Run locally

1. Install Meteor.
2. Install npm dependencies:
   ```bash
   meteor npm install
   ```
3. Start the app:
   ```bash
   meteor
   ```

## Tailwind

Tailwind is configured via:
- `tailwind.config.js`
- `imports/ui/styles/tailwind.input.css`
- generated output: `client/tailwind.generated.css`
- import point: `client/main.css`

Build Tailwind once:

```bash
npm run tailwind:build
```

Watch during development (separate terminal):

```bash
npm run tailwind:watch
```

## Task coverage

This baseline covers `T-000` from `TASKS - Sms System (third prototype).md`:
- Meteor app skeleton (manual, due local Meteor CLI architecture error during scaffold)
- Boilerplate removed
- `.gitignore`
- local run instructions
- Tailwind config files and CLI build scripts

## PR workflow

- Open all changes through pull requests.
- Use `.github/pull_request_template.md`.
- `main` is configured to require PR-based merges.
