# oab-wizard

Client-side setup wizard for [OpenAB](https://github.com/openabdev/openab) — form on the left, live `config.toml` preview on the right.

**▶ Online demo: https://openabdev.github.io/wizard/**

Prototype for the web-onboarding alternative discussed in [openabdev/openab#1372](https://github.com/openabdev/openab/issues/1372).

## Principles

- **Fully static, fully client-side.** No backend, no network calls. Hosted on GitHub Pages; deployable to any static host.
- **Never accepts secrets.** Sensitive fields take either a plain `${ENV_VAR}` reference or a named entry from `[secrets.refs]` (`aws-sm://` / `exec://` — the two providers openab actually supports), interpolated as `${secrets.<name>}`. The wizard emits per-target secret templates with placeholders; real values are filled out-of-band.
- **Schema-driven.** Sections and fields are data in `schema.js` (derived from `config.toml.example`). Adding a platform is a schema entry, not new UI code. Long-term this should be generated from the config structs (e.g. `schemars` → JSON Schema) so the wizard can't drift from the code.
- Credential validation is out of scope by design — that belongs in the CLI (`openab validate` / first run), not in a browser (CORS makes it impossible anyway).

## Run locally

Any static file server works:

```sh
python3 -m http.server 8787
# or: npx serve .
open http://localhost:8787
```

## Deploy

GitHub Pages serves `main` at https://openabdev.github.io/wizard/ — push to deploy. No build step. When changing `app.js`/`schema.js`/`style.css`, bump the `?v=` query in `index.html` to bust browser caches.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Two-pane layout shell |
| `schema.js` | Platform/agent/pool field definitions + i18n strings (the only file to touch for new platforms) |
| `app.js` | Form rendering, state, TOML generation, secret ref palette, syntax highlighting |
| `style.css` | Light theme styling |

## Status

Prototype. Covered: Discord, Slack, Telegram, LINE adapters; `[stt]`; `[secrets.refs]` (aws-sm/exec) with drag-in or picker assignment; `[agent]` env editor; EN/繁中 i18n; three deployment targets (Helm `configToml`, Docker, ecsctl + `configUrl`). Not covered yet: gateway/wecom/googlechat/teams/feishu sections, reactions, cron, ambient mode, TOML import (reverse direction).
