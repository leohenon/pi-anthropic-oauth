# pi-anthropic-oauth

[![npm](https://img.shields.io/npm/v/pi-anthropic-oauth?style=flat-square&logo=npm&logoColor=white&label=npm&color=7c3aed)](https://www.npmjs.com/package/pi-anthropic-oauth) [![node](https://img.shields.io/badge/node-%3E%3D18-7c3aed?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)

Use Claude Pro/Max in Pi with browser OAuth.

## Features

- Claude Pro/Max login from `/login`
- Automatic token refresh
- Claude Code-compatible OAuth headers and prompt shaping
- No Anthropic API key needed
- Uses Pi's Anthropic model registry
- Adds Claude Opus 4.8 by default
- Auto-creates `~/.Claude Code` → `~/.pi` symlink when missing

## Quick start

```bash
pi install npm:pi-anthropic-oauth
```

Start Pi, then run Pi's login command:

```text
/login
```

Choose:

```text
Claude Pro/Max
```

Complete the browser login. After login, select an Anthropic model in Pi.

> [!WARNING]
> Use at your own risk. This may go against Anthropic's terms.

> [!NOTE]
> Anthropic auth changes are closely monitored for quick compatibility updates.

## System prompt rewriting

When using Claude Pro/Max OAuth, the extension prepends Claude Code identity text and rewrites standalone `Pi` / `pi` references in Pi's system prompt to `Claude Code`. The rewrite mode defaults to `aggressive`:

```bash
PI_ANTHROPIC_OAUTH_REWRITE_MODE=aggressive
```

Available modes:

| Mode | Behavior |
|------|----------|
| `aggressive` | Default. Replaces standalone `Pi` / `pi` wherever the word-boundary pattern matches. |
| `path-safe` | Avoids replacing `Pi` / `pi` immediately after `/` or `\`, preserving path segments like `/srv/dev/pi-foo`. |
| `technical-safe` | Avoids replacing `Pi` / `pi` next to common technical-token separators: `/`, `\`, `.`, `@`, `:`, `_`, `-`. |
| `custom` | Uses `PI_ANTHROPIC_OAUTH_REWRITE_PATTERN` as the replacement regex. |

Custom patterns can be a regex source or a JavaScript-style regex literal. The `g` flag is added automatically when omitted:

```bash
PI_ANTHROPIC_OAUTH_REWRITE_MODE=custom
PI_ANTHROPIC_OAUTH_REWRITE_PATTERN='(?<![/\\])\b[Pp]i\b'
# or
PI_ANTHROPIC_OAUTH_REWRITE_PATTERN='/\bpi\b/gi'
```

There is no separate off mode. If you need to disable rewriting entirely, use a custom pattern that never matches, such as `(?!)`.

## Extra models

To add another Anthropic model, create `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "unused",
      "api": "anthropic-messages",
      "models": [
        {
          "id": "your-model-id",
          "name": "Your Model Name"
        }
      ]
    }
  }
}
```

> [!NOTE]
> Custom models are not needed for Claude Opus 4.8; this extension registers `claude-opus-4-8` automatically.
>
> Pi requires `baseUrl`, `apiKey`, and `api` when defining custom models in `models.json`. With this extension, requests normally authenticate through Claude Pro/Max OAuth after `/login`, so `apiKey` is only a placeholder to satisfy Pi's config requirements and does not need to be a valid Anthropic API key.
>
> Do not use a fake `sk-ant-oat...` value as the placeholder. If OAuth login has not completed, Pi may try to use that fake token and Anthropic will return `401 Invalid bearer token`. Use a harmless placeholder such as `"unused"`, then run `/login` and choose `Claude Pro/Max`.

## Troubleshooting

- Run `/login` with no arguments, then choose `Claude Pro/Max`.
- If local callback login does not complete, paste the final callback URL or `code#state` when prompted
- If you see `401 Invalid bearer token`, remove any fake `sk-ant-oat...` placeholder from `~/.pi/agent/models.json` and log in again
- If something breaks, please open an issue with your Pi version, extension version, and error output

## License

MIT
