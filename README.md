# oab-wizard

Client-side setup wizard for [OpenAB](https://github.com/openabdev/openab) — form on the left, live `config.toml` preview on the right.

Prototype for the web-onboarding alternative discussed in [openabdev/openab#1372](https://github.com/openabdev/openab/issues/1372).

## Principles

- **Fully static, fully client-side.** No backend, no network calls. Deployable to Cloudflare Pages as-is.
- **Never accepts secrets.** Secret fields render as `${ENV_VAR}` references in the TOML; the wizard emits a per-target secret template (`.env`, `docker --env-file`, or K8s Secret / `kubectl create secret`) with placeholders. Real values are filled locally by the user.
- **Schema-driven.** Sections and fields are data in `schema.js` (derived from `config.toml.example`). Adding a platform is a schema entry, not new UI code. Long-term this should be generated from the config structs (e.g. `schemars` → JSON Schema) so the wizard can't drift from the code.
- Credential validation is out of scope by design — that belongs in the CLI (`openab validate` / first run), not in a browser (CORS makes it impossible anyway).

## Run locally

Any static file server works:

```sh
python3 -m http.server 8787
# or: npx serve .
open http://localhost:8787
```

## Deploy (Cloudflare Pages)

No build step — point Pages at the repo root, build command empty, output directory `/`.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Two-pane layout shell |
| `schema.js` | Platform/agent/pool field definitions (the only file to touch for new platforms) |
| `app.js` | Form rendering, state, TOML + secret artifact generation |
| `style.css` | Styling |

## Status

Prototype. Covered: Discord, Slack, Telegram, LINE adapters; agent backend presets; session pool; three deployment targets. Not covered yet: gateway/wecom/googlechat/teams/feishu sections, reactions, cron, ambient mode, TOML import (reverse direction).
