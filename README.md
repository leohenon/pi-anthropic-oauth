# pi-anthropic-oauth

[![npm](https://img.shields.io/npm/v/pi-anthropic-oauth?style=flat-square&logo=npm&logoColor=white&label=npm&color=7c3aed)](https://www.npmjs.com/package/pi-anthropic-oauth) [![node](https://img.shields.io/badge/node-%3E%3D18-7c3aed?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)

Use Claude Pro/Max in Pi with browser OAuth.

## Features

- Claude Pro/Max login from `/login anthropic`
- Automatic token refresh
- Claude Code-compatible OAuth headers and prompt shaping
- No API key or extra usage needed.
- Uses Pi's Anthropic model registry
- Adds Claude Opus 4.7 by default
- Auto-creates `~/.Claude Code` → `~/.pi` symlink when missing

## Quick start

```bash
pi install npm:pi-anthropic-oauth
```

Start Pi, then run:

```text
/login anthropic
```

Choose:

```text
Claude Pro/Max
```

> [!WARNING]
> Use at your own risk. This may go against Anthropic's terms.

> [!NOTE]
> Anthropic auth changes are closely monitored for quick compatibility updates.

## Extra models

To add another Anthropic model, create `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "REQUIRED_BY_PI_FOR_CUSTOM_MODELS",
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
> Pi requires `baseUrl`, `apiKey`, and `api` when defining custom models in `models.json`. With this extension, requests normally authenticate through Claude Pro/Max OAuth after `/login anthropic`, so `apiKey` is present to satisfy Pi's config requirements and does not need to be a valid Anthropic API key.

## Troubleshooting

- Re-run `/login anthropic` if auth looks stale
- If local callback login does not complete, paste the final callback URL or `code#state` when prompted
- If something breaks, please open an issue with your Pi version, extension version, and error output

## License

MIT
