# dsh-channel-wechat

English | [中文](./README.md)

A channel plugin that connects WeChat (Tencent iLink / ClawBot) to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). One npm package provides both the Harness bundle and the GUI browser half; it runs inside the Harness process.

## What it supports

- Two-way text, image, and file messaging.
- Inbound WeChat messages become DSH turns; durable `session/event` messages are sent back to WeChat.
- Commands in WeChat (`/help`, `/skills`, `/cwd`, `/models`, `/model`, `/status`, `/stop`, `/new`), approval cards, and question cards.
- `/cwd <absolute-path>` switches the working directory from WeChat: the current conversation ends and a new one starts in that directory, and the choice survives a restart.
- An approval card can switch the current conversation to full access; WeChat shows "typing" while a turn runs.
- QR login, sign-out, working directory, card delivery, model, and permission settings on the GUI plugin page.
- Long polling decoupled from turn processing, with terminal and file diagnostics.

Group chats, multiple accounts at runtime, unsolicited push, and a separate permission system are out of scope.

## Requirements

| Component | Requirement |
|---|---|
| Node.js | `^22.19.0` or `>=24.0.0` |
| pnpm | 11 (`package.json` declares `pnpm@11.7.0`) |
| DeepSeek Harness | `>=0.2.0-rc.1` |

The install floor comes from `package.json` `engines`; see [compatibility](./docs/compatibility.md) for verified and unverified versions.

## Quick start

1. Make sure the profile has a working directory you want to use for WeChat sessions.
2. Install the plugin and restart DSH:

   ```bash
   dsh plugin --profile <your-profile> add dsh-channel-wechat
   ```

3. Open **Plugins → dsh-channel-wechat** in the GUI, click **Sign in to WeChat**, and scan the QR code. Enter a verify code on the page if requested.
4. Send a message to the bot from WeChat and confirm that the DSH reply arrives there.

A full DSH restart is required after installation so the host can discover the browser half. If pnpm's observation window skips a just-published release, use:

```bash
dsh plugin --profile <your-profile> add dsh-channel-wechat@latest --config.minimumReleaseAge=0
```

## Configuration

The GUI page edits all fields. The same values can be written in the profile's `cordis.patch.yml`:

```yaml
- id: channel-wechat
  config:
    cwd: /your/workspace
    cards: wechat
    provider: ''
    model: ''
    permission: workspace-write
```

`cwd` must be absolute. It is recorded when a session is created and cannot be changed for that session; edits affect sessions created afterwards. See [configuration reference](./docs/configuration.md) for fields, defaults, and permission boundaries.

Profiles without a web app can use the terminal:

```bash
dsh <profile> login
dsh <profile> status
dsh <profile> logout
```

On web/desktop profiles the launcher rejects the `login` positional argument before this plugin runs; use the GUI instead.

## Data and logs

| What | Location |
|---|---|
| Session transcript | `~/.dsh/sessions/<escaped cwd>/channel-wechat-<peerId>[~g<N>]/session.v4.jsonl.zstd` |
| Plugin state | `~/.dsh/channel-wechat/` |
| Diagnostic log | `~/.dsh/channel-wechat/log/channel-wechat-YYYY-MM-DD.log`, kept 7 days |
| Login credential | `~/.dsh/.credentials.yaml` |

DSH persists the transcript. `/new` creates a new conversation generation and does not delete older records. Never share tokens, cookies, or credential files when reporting an issue.

## Troubleshooting

- **No configuration section**: fully quit and reopen DSH; see [troubleshooting](./docs/troubleshooting.md).
- **Login argument rejected**: web/desktop profiles support GUI login only.
- **No reply**: check the plugin log, account status, and that `cwd` is absolute.
- **Media or quote degraded to text**: some quote fields and the server's uint64 message id are known limitations; see troubleshooting.

## Documentation

### User guides

- [Commands in WeChat](./docs/commands.md)
- [Additional installation paths](./docs/installation.md)
- [Configuration reference](./docs/configuration.md)
- [Compatibility and verification](./docs/compatibility.md)
- [Troubleshooting](./docs/troubleshooting.md)

## Get help

Start with [troubleshooting](./docs/troubleshooting.md) and the plugin log. If the issue remains, open a [GitHub Issue](https://github.com/wangx-wx/dsh-channel-wechat/issues) with the DSH version, plugin version, profile type, reproduction steps, and redacted logs. Do not include tokens, cookies, or credential files.

### Development and design

- [Development and verification](./docs/development.md)
- [Architecture](./docs/architecture.md)
- [Delivered capabilities](./docs/milestones.md)
- [Implementation plan and decision log](./docs/plan-v1.md)
- [Invariants](./docs/invariants.md)
- [Protocol document](./docs/protocol/protocol_zh_CN.md)
- [Requirements](./spec/)
- [Reconnaissance reports](./docs/recon/)
- [Development log](./docs/dev-log/)
- [Release process](./docs/release.md)
- [Contributing guide](./CONTRIBUTING.md)

## Contributing and maintenance

Bug reports, suggestions, and pull requests are welcome through [GitHub Issues](https://github.com/wangx-wx/dsh-channel-wechat/issues). Before submitting a change, read [Development and verification](./docs/development.md) and run the build, type check, and relevant tests. Maintainer and repository information is available in the [GitHub repository](https://github.com/wangx-wx/dsh-channel-wechat).

## Local development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm test:integration
```

Integration tests use a temporary isolated `DSH_HOME` and look for a local DeepSeek Harness checkout. Set `DSH_CHECKOUT=/path/to/deepseek-harness` when needed. See [development and verification](./docs/development.md).

## License and third-party notices

This project is MIT licensed. See [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for complete notices. The protocol implementation follows Tencent's [`openclaw-weixin`](https://github.com/Tencent/openclaw-weixin).
