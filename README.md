# Pi Anthropic OAuth

[![npm](https://img.shields.io/npm/v/pi-anthropic-oauth?style=flat-square&logo=npm&logoColor=white&label=npm&color=7c3aed)](https://www.npmjs.com/package/pi-anthropic-oauth) [![node](https://img.shields.io/badge/node-%3E%3D18-7c3aed?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)

Claude Pro/Max OAuth extension for Pi.

> [!WARNING]
> Use this at your own risk. This may go against Anthropic's terms.

## Install

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

## Notes

- uses Pi's built-in Anthropic model list
- sends Claude Code-like OAuth headers
- rewrites Pi system identity where needed
- auto-creates `~/.Claude Code` → `~/.pi` symlink

## Custom models

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

## License

MIT
