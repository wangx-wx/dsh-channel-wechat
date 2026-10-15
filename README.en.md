# dsh-channel-wechat

English | [中文](./README.md)

A **channel plugin** that connects WeChat (Tencent iLink / ClawBot) to
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

> Status: **v0.1.1, published to npm**. Outbound files are **verified on a real
> device**; the `svr_id` quote shape and `message_id` precision are **recorded
> known issues** (see [plan-v1 §Q45](./docs/plan-v1.md)).

---

## Install

```bash
dsh plugin --profile <your-profile> add dsh-channel-wechat
```

Then **restart DSH**. That is all — `add` builds it and registers the package in
the profile's `bundles` layer.

### Using it

1. On startup the log prints a login address:
   ```
   [channel-wechat] WeChat login: open http://127.0.0.1:<port>/api/channel-wechat/login in mobile WeChat and scan
   ```
2. Scan it with **mobile WeChat** and confirm — **no restart needed**; credentials
   are stored and long-polling starts.
3. Message that bot in WeChat from then on; DSH's replies come back to WeChat.

⚠️ **Decide `cwd` before installing.** The `cwd` config sets the working directory
of every WeChat session, and it is **written at session creation and immutable**.
Unset, it takes the launcher's `process.cwd()` — which on desktop is
`~/.dsh/profiles/desktop`, not somewhere an agent should work. Set it in the
profile's `cordis.patch.yml`:

```yaml
- id: channel-wechat
  config:
    cwd: /your/working/directory
    cards: wechat        # WeChat-only cards (default); `both` also shows the GUI card
```

### Other install paths

From git (pnpm builds it via `prepack`), or a local tarball:

```bash
dsh plugin --profile <your-profile> add github:wangx-wx/dsh-channel-wechat
dsh plugin --profile <your-profile> add ./dsh-channel-wechat-0.1.0.tgz
```

For a git dependency pnpm **refuses to run build scripts**, so the first attempt
fails and prints an `allowBuilds` entry. Add it to the profile's
`pnpm-workspace.yaml` and retry (pnpm's safety mechanism, not a plugin defect):

```yaml
allowBuilds:
  dsh-channel-wechat@<the full key pnpm printed>: true
```

⚠️ **Do not `add` a local directory.** That creates a `link:`, and **`link:` runs
no build**. Since `lib/` is gitignored, the installed package has no `lib/`, so
startup reports `failed to import` and **silently loads nothing**. If you must,
run `pnpm install && pnpm build` in that directory first.

> **What `bundles` is**: `dependencies` says what to *download*; the profile's
> `dsh.profile.bundles` says what to *load*. Present in the former but not the
> latter means installed and **never loaded** — zero lines in `--dump-config`, no
> error. `dsh plugin add` writes both; attaching by hand with `link:` writes only
> the first, which is why the desktop profile was installed but never active.

## What this is

A standard DSH **plugin + bundle** (one package) that runs inside the Harness
process. There is no separate bridge process:

```
WeChat user ⇄ Tencent iLink ⇄ 【this plugin (inside the DSH process)】
                ├─ getUpdates long-poll for inbound messages
                ├─ agent.followup() injects the turn natively
                ├─ session/event → sendmessage for replies
                ├─ approval and question cards (WeChat and GUI)
                └─ login panel (web / desktop)
```

- **Protocol layer ported from Tencent's official implementation**
  (`@tencent-weixin/openclaw-weixin`, MIT), with its fidelity and test baseline
- **DSH integration layer written from scratch**, against the documented
  contracts (typed, not duck-typed)
- **Sessions and working directory**: the directory comes from the profile's
  `cwd` config and is written when the session is created — immutable after
  that. The `/cwd` command is registered but **not implemented yet**; it says so
  explicitly rather than failing silently
- **Long-polling decoupled from processing**: messages keep arriving during a
  long turn, and `/stop` can interrupt it

## Login

On startup the plugin prints an address you can open directly:

```
[channel-wechat] 微信登录：用手机微信打开 http://127.0.0.1:19387/api/channel-wechat/login 扫码连接
```

Open it with **WeChat on your phone** and scan. No restart is needed: the
credential is written to `ctx.credentials` immediately and the channel begins
polling in the same process.

### Why not `dsh <profile> login`

Because it is **impossible on a profile that mounts the web app** (web /
desktop). This is not this plugin's choice:

The DSH launcher hands the **same complete argument list** to **every** app in
the profile, and each parses it. `dsh-web-app`'s program **declares flags only
and has no positional**, so it judges `login` as `too many arguments` and calls
`exit(1)` — **the boot ends before it ever reaches this plugin**.
`-- login`, `--json`, `--wechat-login`, and ordering this plugin's bundle before
the web app were all **measured to fail** (none of the five official
command-line-parsing apps tolerates an unknown argument, and that is deliberate).

Two comparable plugins avoid this road as well: `dsh-wechat` has no CLI at all
and only offers an HTTP page; `dsh-weixin`'s CLI is a **separate executable**, and
its README lists the panel as the preferred path.

The CLI's `login`/`logout`/`status` are still present, but only work on a profile
that does **not** mount the web app.

## Differences from comparable plugins

| | `dsh-wechat` | `dsh-weixin` | **this plugin** |
|---|---|---|---|
| Types | TS strict | plain JS | TS strict |
| Protocol fidelity | three inbound-media gaps | no `-14` / no dedup | matches upstream + ports its tests |
| Slash commands | 17 | none | native passthrough + 6 self-managed |
| Concurrency | serial, blocking | serial, blocking | decoupled and interruptible |
| Panel auth | routes exposed | no auth at all | **behind `/api`, reusing the GUI's token wall** |

## Documentation

The design documents are written in Chinese.

| Document | Contents |
|---|---|
| [docs/plan-v1.md](./docs/plan-v1.md) | **Implementation plan (final)**: decision log, architecture, milestones, risks |
| [docs/design.md](./docs/design.md) | Early design draft (v0.3, partly superseded by plan-v1) |
| [docs/事实核查.md](./docs/事实核查.md) | Protocol fact-checking and corrected conclusions |
| [docs/recon/](./docs/recon/) | **13 reconnaissance reports**: protocol, build, DSH contracts, comparable implementations |
| [开发日志.md](./开发日志.md) | Decision log in reverse chronological order |

## Milestones

| Stage | Content | Acceptance |
|---|---|---|
| **M0** ✅ | Package skeleton + real composition test | cordis fiber reaches `ACTIVE` |
| **M1** ⚠️ | Protocol layer + credential persistence | CLI path unusable on web/desktop → moved to the panel |
| **M2** ✅ | **Text end to end** | WeChat message → DSH reply arrives |
| **M3** ✅ | Commands + `/stop` | Native commands get a receipt; interrupts work |
| **M4** ✅ | Media both ways + quotes | images ✅ / quotes ✅ / **outbound files ✅ verified on a real device** |
| **M5** ✅ | Approval + question cards | WeChat approves/rejects/answers; with `cards: wechat` the GUI shows no duplicate |
| **M6** 🔶 | Login panel | Scan-to-login verified on web, login starts the channel; settings-page card pending |
| **M7** ✅ | Release | **v0.1.1 is on npm**; `dsh plugin add dsh-channel-wechat` verified installing and loading in a fresh profile |

## Where data lives

| What | Where |
|---|---|
| **Chat transcript** | `~/.dsh/sessions/<escaped cwd>/channel-wechat-<peerId>[~g<N>]/session.v4.jsonl.zstd` |
| Plugin state | `~/.dsh/channel-wechat/` (cursor and conversation generations) |
| **Diagnostic log** | `~/.dsh/channel-wechat/log/channel-wechat-YYYY-MM-DD.log` |
| Login credential | `~/.dsh/.credentials.yaml` (the harness credential store, not private to this plugin) |

**The transcript is persisted by the harness** (`ctx.agents` → `sessionPersistence`);
this plugin writes no session file. It is zstd-compressed JSONL, readable with
`zstd -d -c <file> | less`.

**The log is one file per local date, kept for seven days.** It matters most on
the desktop app: the host process's stdout is handed to the Electron main
process, which has no terminal and writes no log file, so without this file
nothing is visible at all.

⚠️ **The log is pruned after a week, but transcripts are never deleted** - `/new`
only moves to a different session directory, so old conversations accumulate
(the session boundary exposes no delete).

## Known issues (recorded, not fixed)

| Issue | Impact | Trigger |
|---|---|---|
| Quoting **your own message**: the client sends only `svr_id` | Shows `[引用] （引用的消息内容未能读取）`; quoting an agent message works | Needs a message cache before it can be restored |
| `message_id` is typed `number` but the server sends a uint64 | Affects one number in one error log line | Above 2^53, and once a quote cache exists |

Tradeoffs and measurements: [plan-v1 §Q45](./docs/plan-v1.md).

### Development

```bash
pnpm install
pnpm test              # unit tests (milliseconds)
pnpm test:integration  # real composition: boots the real launcher on an isolated DSH_HOME
pnpm typecheck
pnpm build             # `prepack` runs this automatically before publish
```

**Releasing a new version**: see [docs/release.md](./docs/release.md) (switch to the
official registry → publish → wait for review → switch back to the mirror).

The integration tests create an isolated `DSH_HOME` in a temporary directory and
**never touch the dsh profile you are using**.

They need a real launcher to boot, and default to the **local DSH checkout**
(via `node apps/cli/lib/bin.js`; no Electron, and it can point at any version):

```bash
DSH_CHECKOUT=/path/to/deepseek-harness pnpm test:integration  # override the checkout
```

If that checkout is absent, they fall back to the `dsh` shim inside
`DeepSeek Harness.app`.

## Not in scope

Group chats (no protocol basis), multiple accounts at runtime, message
deduplication/throttling (matching upstream), unsolicited push (v2), a separate
authorization system.

> **Question cards shipped in v1** (not v2): an unclaimed `ask_user_question`
> wedges the whole turn forever, so it was built alongside approval cards — see
> [plan-v1 §Q42](./docs/plan-v1.md).

## License and acknowledgements

- The protocol specification and parts of the implementation come from Tencent's
  [`openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) (**MIT**,
  `Copyright (C) 2026 Tencent`); full notices in
  [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)
- Engineering practices referenced from `wechat-claude-code` (MIT)
- This plugin is licensed **MIT**
