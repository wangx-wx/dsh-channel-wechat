# dsh-channel-wechat

English | [中文](./README.md)

A **channel plugin** that connects WeChat (Tencent iLink / ClawBot) to
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

> Status: **v0.2.1, published to npm** (version numbers track the DSH
> major.minor from this release on; see Versions and compatibility below).
> Signing in and configuring happen on
> the plugin's page in the GUI, and the plugin takes one row in a profile. That
> page also picks the **default model** and the **WeChat session permission**
> (three presets, the widest behind a risk confirmation, all scoped to WeChat
> sessions).
> Outbound files are **verified on a real device**; the `svr_id` quote shape and
> `message_id` precision are **recorded known issues** (see
> [plan-v1 §Q45](./docs/plan-v1.md)).

### Versions and compatibility

A plugin version is **`<DSH major>.<DSH minor>.<our own patch>`** (no `rc` or
`alpha`): `0.2.x` pairs with the DSH `0.2` generation, `0.3.y` with `0.3`. **The
patch number is entirely ours** — when DSH ships `0.2.2` we do not renumber;
only a change of our own bumps it.

**Whether an install is allowed is decided by the `engines.dsh` floor**,
`>=0.2.0-rc.1`. There is deliberately **no upper bound**:

| DSH version | Installable | Verified |
|---|---|---|
| `0.2.0-rc.2` (packaged desktop app) | ✅ | ✅ 99 integration tests pass |
| `0.2.1-rc.1` (installed from npm, real launcher) | ✅ | ✅ 99 integration tests pass |
| other `0.2.x` / `0.3.x` / `1.x` | ✅ | ⚠️ not individually measured |
| older than `0.2.0-rc.1` | ⛔ refused at install with the reason | — |

> "99 pass" means the full run, **nothing skipped**. An earlier version of this
> table recorded "84 pass, 15 skipped" for `0.2.0-rc.2`, which was a
> **misattribution**: the skips were `client-half-runs`, which needs the
> checkout's `ui-theme` sources and react. That is unrelated to the DSH version —
> the same suite runs all 99 on `0.2.0-rc.2` whenever the source tree is
> available.

**"Installable" and "verified" are different claims.** The ceiling is left open
because a ceiling would block every user as soon as DSH ships a new release and
this plugin has not republished — for a channel plugin, being immediately
unusable is worse than running on an unmeasured version.

---

## Install

```bash
dsh plugin --profile <your-profile> add dsh-channel-wechat
```

Then **restart DSH**. That is all — `add` builds it and registers the package in
the profile's `bundles` layer.

> **To get a just-published version, turn the observation window off explicitly.**
> pnpm applies a supply-chain observation window (`minimumReleaseAge`, 24 hours by
> default), so a version published minutes ago is **skipped** and you get the
> previous one. Note that **`@latest` does not help**: the check runs after
> version resolution, and `add pkg@latest` was measured to install the same old
> version as `add pkg`. Use:
>
> ```bash
> dsh plugin --profile <your-profile> add dsh-channel-wechat@latest --config.minimumReleaseAge=0
> ```
>
> Measured on both pnpm 11.7.0 and 11.9.0: with the flag it installs the newest,
> without it the previous one. The flag works without `@latest` too. **The cost**
> is that the version ships without an observation period — your call.
>
> **Restart fully after installing**, see the static module graph entry under
> Known issues below.

### Using it

1. Open the GUI, go to **Plugins** in the sidebar, and open the
   **dsh-channel-wechat** card.
2. Click **Sign in to WeChat**; the QR code appears on the page.
3. Scan it with **mobile WeChat** and confirm (enter the verify code in the page
   if asked) — **no restart needed**; credentials are stored and long-polling
   starts.
4. Message that bot in WeChat from then on; DSH's replies come back to WeChat.

The same page carries this plugin's settings (`cwd`, `cards`); saving applies
them, so there is no YAML to hand-edit.

> Without a GUI (a profile that mounts no web app, such as headless),
> `dsh <profile> login` still prints the QR code to the terminal. Note that
> **it cannot work on a profile that mounts the web app** (web / desktop): that
> app's own argument parser rejects the positional before this plugin is
> reached, so the boot ends first. See "Login" below.

⚠️ **Get `cwd` right.** It sets the working directory of every WeChat session,
and it is **written at session creation and immutable**. Unset, it takes the
launcher's `process.cwd()` — which on desktop is `~/.dsh/profiles/desktop`, not
somewhere an agent should work. The plugin's settings page edits it (affecting
only sessions created afterwards); the profile still works too:

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
                └─ plugin page (GUI): sign in / sign out / settings
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

**The GUI is the primary entry point**: sidebar **Plugins** →
**dsh-channel-wechat** → **Sign in to WeChat**. The QR code renders on the page,
and confirming it needs no restart: the credential is written to
`ctx.credentials` immediately and the channel begins polling in the same process.
The same page has **Sign out**, which stops polling before deleting the credential.

Without a GUI (a profile that mounts no web app), use the terminal:

```bash
dsh <profile> login     # prints the QR code
dsh <profile> status    # shows what is stored
dsh <profile> logout    # signs out
```

### Why `dsh <profile> login` cannot work on web / desktop

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

### Why there is one plugin entry

Earlier versions put **two rows** in the profile: a
`dsh-channel-wechat/startup` row that parsed the `login`-style app argument (only
a row declaring `inject` is handed the command line), and the channel row itself.

They are one row now: every launcher provides `cmdlineArgs` before the tree
mounts, so the main row declares it directly. The GUI shows one card, and the CLI
still works on a profile that mounts no web app.

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
| [docs/invariants.md](./docs/invariants.md) | **Why the invariants hold**: consequence of breaking each, and where the evidence is |
| [docs/design.md](./docs/design.md) | Early design draft (v0.3, partly superseded by plan-v1) |
| [docs/事实核查.md](./docs/事实核查.md) | Protocol fact-checking and corrected conclusions |
| [docs/recon/](./docs/recon/) | **13 reconnaissance reports**: protocol, build, DSH contracts, comparable implementations |
| [docs/dev-log/](./docs/dev-log/) | Development log: decisions and changes in reverse chronological order, one per version |

## Milestones

| Stage | Content | Acceptance |
|---|---|---|
| **M0** ✅ | Package skeleton + real composition test | cordis fiber reaches `ACTIVE` |
| **M1** ⚠️ | Protocol layer + credential persistence | CLI path unusable on web/desktop → moved to the panel |
| **M2** ✅ | **Text end to end** | WeChat message → DSH reply arrives |
| **M3** ✅ | Commands + `/stop` | Native commands get a receipt; interrupts work |
| **M4** ✅ | Media both ways + quotes | images ✅ / quotes ✅ / **outbound files ✅ verified on a real device** |
| **M5** ✅ | Approval + question cards | WeChat approves/rejects/answers; with `cards: wechat` the GUI shows no duplicate |
| **M6** ✅ | GUI login and configuration | Scan-to-login / sign-out on the plugin's page; `cwd` and `cards` editable there |
| **M8** ✅ | GUI page and one row | **v0.1.2**: sign-in / sign-out / settings on the plugin's page; one row per profile |
| **M9** ✅ | Model and permission settings | Pick the **default model** and the **WeChat session permission** (three presets, the widest behind a risk confirmation) on the plugin's page |
| **M7** ✅ | Release | **v0.1.1** first verified installing and loading in a fresh profile |

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
| **No restart after install means no configuration section** | The login and configuration panel is missing entirely, **with no error anywhere** | The Host starts before the package lands on disk — the normal case for an install from the Plugins page |

Tradeoffs and measurements: [plan-v1 §Q45](./docs/plan-v1.md).

### In detail: installing requires a restart

**Symptom.** The plugin is installed and the host half is entirely healthy
(`/api/channel-wechat/status` answers 200, the log has the sign-in line, the
`dsh-channel-wechat` card and its version are shown) — but **the configuration
section on the plugin's page never appears**: no sign-in or QR, no `cwd`, model
or permission. Nothing is logged or thrown.

**This is not a defect in this plugin, and the version does not matter.** The
cause is the host package `@deepseek-ai/dsh-client-modules`:

- It composes each plugin's browser half (`lib/client.js`) into the boot graph.
  Only when a package is in that graph does the browser run
  `ctx.slots.register('plugins.bundle.config', …)` and render the section.
- Its package-resolution result is **cached permanently**: a failure is recorded
  as `null` and never invalidated until the process restarts.
- So whenever **the package is absent from `node_modules` at the moment the Host
  starts**, that row can never enter the graph:
  `/plugins/??dsh-channel-wechat/client.js` answers 404 forever and the section
  stays empty.

That window is **the normal case for an install from the Plugins page** — the
Host is already running when pnpm writes the package. Whichever version
makes no difference, because the staleness is fixed at the first resolution, not
by the version installed later.

**How to tell.** Rule out "the page just needs a reload" first — **quit DSH
completely and start it again**. If the section appears, this was it; if not,
something else is going on.

**Why this is recorded rather than fixed.** The fix belongs to the host's
`dsh-client-modules` (its negative cache must be invalidatable), not to this
repository. This plugin can only document the workaround.

The workaround is one line: **after installing or upgrading a plugin, quit DSH
completely and reopen it.**

### Known boundary: WeChat can widen its own permission

`/permission` is a DSH command, and this plugin forwards **every non-local command** to the
harness (the local ones are only `stop`/`status`/`new`/`cwd`/`help`/`reconnect`). So sending

```
/permission danger-full-access
```

from WeChat turns the current session's approvals off - that preset bundles `approval: never`,
which is settled before this plugin's approval cards are reached, so **the cards stop appearing**.

- **Persistence**: it writes the session's own durable event, so it survives a restart; it applies
  to that one conversation only, and `/new` starts again from the default.
- **Why it is not changed**: this channel is **single-party by design** (Q37 in
  `docs/invariants.md`: a WeChat message inherits the authority of any other local input, and the
  operator is the user). If it ever serves a group or an untrusted source, that assumption must be
  overturned.
- The page's "WeChat session permission" applies to sessions created **after** the change and never
  rewrites an existing one, so a temporary choice made inside a conversation is respected.


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
