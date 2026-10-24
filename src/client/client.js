/**
 * The plugin's page in the GUI: connect a WeChat login, and edit this plugin's
 * configuration.
 *
 * Hand-written lazy-CJS rather than a bundled TSX entry. The loader's wrapper is
 * the entire artifact, and this page needs no CSS modules, no dynamic chunks and
 * no JSX build - `docs/recon/13` records that reproducing the repository's
 * tsdown client preset is only necessary for those. `scripts/copy-client.mjs`
 * copies this file to `lib/client.js` byte for byte.
 *
 * Two seams carry the data, and neither is the other:
 *
 *  - the login routes are plain HTTP under `/api/channel-wechat/*`, fetched with
 *    a **document-relative** path (a leading `/` is rejected by the client build
 *    gate and breaks a page served from a subdirectory);
 *  - the configuration goes through `ctx.configForms`, which is what actually
 *    writes the profile patch. `cwd` and `cards` are volatile, which is the only
 *    reason they can appear here at all: the settings service projects volatile
 *    fields alone, and a non-volatile field is absent from that projection
 *    rather than read-only.
 *
 * The page registers into `plugins.bundle.config`, keyed by this package's name.
 * That is the slot the Plugins page reserves for an installed bundle's own
 * configuration: it renders on the bundle's detail page, between the description
 * and the rows. (`plugins.item` is the other one, and it is deliberately
 * occupied by the official settings pages.)
 */

window.__ModuleLoader__.load({
  id: 'dsh-channel-wechat',
  factory(require) {
    var React = require('react');
    var h = React.createElement;
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    var Button = primitives.Button;
    var Input = primitives.Input;
    var Menu = primitives.Menu;
    var RiskConfirmation = primitives.RiskConfirmation;
    var SegmentedControl = primitives.SegmentedControl;
    var SettingsForm = primitives.SettingsForm;
    var SettingsValueField = primitives.SettingsValueField;
    var SettingsFormModel = primitives.SettingsFormModel;

    /** The settings entry id: the `id` our patch row declares. */
    var NS = 'channel-wechat';
    /** Locale namespace owned by this plugin. */
    var LOCALE_NS = 'channelWechat';
    /** The id the loader registers this bundle under, and the style-ownership key. */
    var PLUGIN_ID = 'dsh-channel-wechat';

    /**
     * The paths this page calls, **document-relative**.
     *
     * No leading slash: the shell injects `<base href="./">`, a page served from
     * a subdirectory would otherwise escape it, and the client build gate rejects
     * a rooted application path outright.
     */
    var ROUTES = {
      status: 'api/channel-wechat/status',
      qr: 'api/channel-wechat/qr.svg',
      begin: 'api/channel-wechat/begin',
      verifyCode: 'api/channel-wechat/verify-code',
      logout: 'api/channel-wechat/logout',
      models: 'api/channel-wechat/models',
      updateCheck: 'api/channel-wechat/update/check',
      updateCommand: 'api/channel-wechat/update/command',
    };

    /** Copy for the page, in the two languages the client selects between. */
    var DICT = {
      zh: {
        connection: '连接',
        connectedAs: '已连接到 {account}',
        notConnected: '尚未连接微信',
        connect: '登录微信',
        reconnect: '重新连接',
        logout: '退出登录',
        logoutConfirm: '确定退出登录？退出后需要重新扫码。',
        waiting: '正在获取二维码…',
        scan: '请用手机微信扫描二维码',
        scanned: '已扫描，请在手机上确认',
        needVerify: '请输入手机上显示的验证码',
        submit: '提交',
        failed: '连接失败',
        config: '设置',
        cwd: '工作目录',
        cwdHint: '微信会话的工作目录。会话创建后不可更改，因此修改只影响之后新建的会话。',
        cwdInvalid: '必须是绝对路径',
        reset: '重置',
        overridden: '已覆盖默认值',
        cards: '审批卡展示位置',
        cardsHint: '“仅微信”时卡片只出现在微信里；“两端”时 GUI 也会显示一张卡，先回答的一方生效。',
        cardsInherit: '继承默认',
        cardsWechat: '仅微信',
        cardsBoth: '两端',
        model: '默认模型',
        modelHint: '微信会话使用的模型。留空表示跟随配置文件的默认模型；修改只影响之后新建的会话。',
        modelInherit: '跟随默认',
        modelLoading: '正在读取模型列表…',
        modelFailed: '读取模型列表失败。',
        modelEmpty: '当前环境没有可用模型。',
        permission: '微信会话权限',
        permissionHint: '微信会话能改动哪些文件。「完全权限」会关闭审批卡，请谨慎选择。',
        permissionReadOnly: '仅查看',
        permissionWorkspace: '工作区内修改',
        permissionFull: '完全权限',
        permissionFullTitle: '确认启用完全权限？',
        permissionFullBody: '完全权限会关闭微信的审批卡确认，并允许直接执行文件修改与外部命令。仅在你信任这个微信号时使用。',
        permissionFullAck: '我已了解风险，并愿意继续',
        permissionFullCancel: '取消',
        permissionFullConfirm: '启用完全权限',
        allow: '允许使用的人',
        allowHint: '只有这里列出的微信账号能用这个机器人，一行一个。留空表示只有扫码登录的那个账号——其他人发来的消息一律忽略。',
        allowPlaceholder: '每行一个微信 id，例如 xxx@im.wechat',
        close: '关闭',
        unavailable: '此部署未提供设置服务。',
        readOnly: '当前连接的设置文档为只读。',
        saveFailed: '保存未被接受。',
        save: '保存',
        saving: '保存中…',
        version: '版本与更新',
        currentVersion: '当前版本 {version}',
        checkUpdate: '检查更新',
        checking: '正在检查…',
        upToDate: '已是最新版本（{version}）。',
        updateFailed: '无法检查更新：{reason}',
        updateAvailable: '有新版本 {latest}，当前 {current}。',
        updateHowTo: '两种更新方式，任选其一。更新后必须完全退出 DSH 再重新打开才会生效。',
        updateWay1: '方式一：在终端执行下面这条命令',
        updateWay2: '方式二：在「设置 → 插件」里先卸载 dsh-channel-wechat，再安装 {spec}',
        updateSpecLabel: '要安装的版本',
        copy: '复制',
        copied: '已复制',
        copyFailed: '复制失败，请手动选中命令',
        updateExitFirst: '执行前请先完全退出 DSH：插件正在运行时，安装会撞上「包已安装」的拒绝。',
        updateAgeNote: '命令带 --config.minimumReleaseAge=0，会跳过 pnpm 的发布观察期。新版本可能刚发布、尚未被广泛验证，请自行判断。',
        updateNoCommand: '此部署无法生成更新命令，请在终端执行 dsh plugin 相关命令。',
        updateDesktopNote: '这是桌面版，只能用应用自带的 dsh 命令。',
      },
      en: {
        connection: 'Connection',
        connectedAs: 'Connected as {account}',
        notConnected: 'Not connected to WeChat',
        connect: 'Sign in to WeChat',
        reconnect: 'Connect again',
        logout: 'Sign out',
        logoutConfirm: 'Sign out? You will need to scan the QR code again.',
        waiting: 'Fetching the QR code…',
        scan: 'Scan the QR code with WeChat on your phone',
        scanned: 'Scanned; confirm on your phone',
        needVerify: 'Enter the code shown on your phone',
        submit: 'Submit',
        failed: 'Connection failed',
        config: 'Settings',
        cwd: 'Working directory',
        cwdHint: 'Working directory for WeChat sessions. A session cannot be moved once created, so a change applies only to sessions created afterwards.',
        cwdInvalid: 'Must be an absolute path',
        reset: 'Reset',
        overridden: 'Overrides the default',
        cards: 'Where approval cards appear',
        cardsHint: 'With WeChat only, a card appears in WeChat alone. With both, the GUI shows one too and the first answer wins.',
        cardsInherit: 'Use default',
        cardsWechat: 'WeChat only',
        cardsBoth: 'Both',
        model: 'Default model',
        modelHint: 'The model WeChat sessions run. Empty follows the profile default. A change applies only to sessions created afterwards.',
        modelInherit: 'Follow the default',
        modelLoading: 'Reading the model list…',
        modelFailed: 'Could not read the model list.',
        modelEmpty: 'This deployment has no available models.',
        permission: 'WeChat session permission',
        permissionHint: 'What WeChat sessions may change. Full access turns the approval cards off — choose it deliberately.',
        permissionReadOnly: 'View only',
        permissionWorkspace: 'Write in workspace',
        permissionFull: 'Full access',
        permissionFullTitle: 'Enable Full access?',
        permissionFullBody: 'Full access turns off the WeChat approval cards and lets the agent change files and run external commands directly. Use it only when you trust this WeChat account.',
        permissionFullAck: 'I understand the risks and want to continue',
        permissionFullCancel: 'Cancel',
        permissionFullConfirm: 'Enable Full access',
        allow: 'Who may use this bot',
        allowHint: 'Only these WeChat ids may drive the bot, one per line. Empty means the account that scanned the login — messages from anyone else are ignored.',
        allowPlaceholder: 'One WeChat id per line, e.g. xxx@im.wechat',
        close: 'Close',
        unavailable: 'This deployment serves no settings.',
        readOnly: 'The connected settings document is read-only.',
        saveFailed: 'The save was not accepted.',
        save: 'Save',
        saving: 'Saving…',
        version: 'Version and updates',
        currentVersion: 'Running {version}',
        checkUpdate: 'Check for updates',
        checking: 'Checking…',
        upToDate: 'Up to date ({version}).',
        updateFailed: 'Could not check for updates: {reason}',
        updateAvailable: 'Version {latest} is available; you are running {current}.',
        updateHowTo: 'Two ways to update, pick one. Both need a full quit and relaunch of DSH to take effect.',
        updateWay1: 'Option 1: run this command in a terminal',
        updateWay2: 'Option 2: in Settings → Plugins, uninstall dsh-channel-wechat, then install {spec}',
        updateSpecLabel: 'Version to install',
        copy: 'Copy',
        copied: 'Copied',
        copyFailed: 'Could not copy; select the command manually',
        updateExitFirst: 'Quit DSH completely first: installing while the plugin is running is refused as "already installed".',
        updateAgeNote: 'The command passes --config.minimumReleaseAge=0, which skips pnpm\'s release observation window. A brand-new release may not have been widely vetted yet.',
        updateNoCommand: 'This deployment cannot produce an update command; run the dsh plugin command in a terminal instead.',
        updateDesktopNote: 'This is the desktop app, so only its bundled dsh command works.',
      },
    };

    /** The strings the Settings form primitives need. */
    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      };
    }

    /** What each reported phase says, as a dictionary key. */
    var PHASE_KEY = {
      idle: 'waiting',
      waiting: 'waiting',
      scanned: 'scanned',
      'need-verifycode': 'needVerify',
      failed: 'failed',
    };

    /**
     * A field for the `cards` enum.
     *
     * The primitives ship no select control (`ConfigField` renders one, but is
     * not exported and not in the built bundle), so an enum field needs its own
     * conversion spec. An empty draft clears the key, which restores the
     * composition default - the gesture the text spec already uses.
     *
     * @param field - the section field name.
     * @param allowed - the values the Host schema accepts.
     * @returns the field's conversion spec.
     */
    function settingsEnumField(field, allowed) {
      return {
        field: field,
        format: function (value) {
          return typeof value === 'string' && allowed.indexOf(value) !== -1 ? value : '';
        },
        parse: function (text) {
          var trimmed = text.trim();
          if (trimmed === '') return { kind: 'clear' };
          return allowed.indexOf(trimmed) === -1 ? undefined : { kind: 'set', value: trimmed };
        },
      };
    }

    /**
     * Whether `value` names one fixed location, in either spelling the Host
     * accepts.
     *
     * The browser has no `node:path` and cannot know which platform the Host
     * runs on, so this is the one place the page decides what "absolute" means.
     * The rule is deliberately the Host's own (`dsh-util-workspace-path`'s
     * `isAbsoluteWorkspacePath`, `packages/util/workspace-path/src/index.ts`):
     * POSIX-absolute, a drive-qualified Windows path, or a complete UNC share.
     *
     * Two near misses are refused on purpose. `D:dsh-ws` is drive-RELATIVE - it
     * resolves against that drive's current directory, which is process state.
     * `\foo` passes `win32.isAbsolute` yet still resolves against the process's
     * current drive, which is why the Host's own directory picker narrows it out
     * (`directory-picker-browse`'s `fullyQualified`). Neither is a fixed
     * location, so neither may be saved as a session's immutable cwd.
     *
     * @param value - the trimmed draft.
     * @returns whether it is an absolute path in one of those spellings.
     */
    function isAbsolutePath(value) {
      if (value.charAt(0) === '/') return true;
      // `C:\...` or `C:/...` - the separator is required, so `C:` alone and
      // `C:relative` (drive-relative) both fall through.
      if (/^[A-Za-z]:[\\/]/.test(value)) return true;
      // A complete `\\server\share` prefix. `\\` and `\\server` alone are
      // incomplete and keep resolving against the current drive.
      return /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
    }

    /**
     * A path field, which has to be absolute.
     *
     * The session boundary rejects a relative path, so an unusable draft is
     * marked invalid here as well as on the Host: that disables the save button
     * and shows why, instead of spending a round trip to be refused.
     *
     * @param field - the section field name.
     * @returns the field's conversion spec.
     */
    function settingsPathField(field) {
      return {
        field: field,
        format: function (value) { return typeof value === 'string' ? value : ''; },
        parse: function (text) {
          var trimmed = text.trim();
          if (trimmed === '') return { kind: 'clear' };
          return isAbsolutePath(trimmed) ? { kind: 'set', value: trimmed } : undefined;
        },
      };
    }

    /**
     * A plain string field.
     *
     * An empty draft clears the key, which is the same reset gesture the path
     * field uses: for the model pair it means "follow the profile default", which
     * is a real state rather than a missing value.
     *
     * @param field - the section field name.
     * @returns the field's conversion spec.
     */
    function settingsTextValueField(field) {
      return {
        field: field,
        format: function (value) { return typeof value === 'string' ? value : ''; },
        parse: function (text) {
          var trimmed = text.trim();
          if (trimmed === '') return { kind: 'clear' };
          return { kind: 'set', value: trimmed };
        },
      };
    }

    /**
     * The menu row id for one provider/model pair.
     *
     * JSON rather than a `provider/model` string: a model id may itself contain a
     * slash (`meta-llama/Llama-3`), so splitting on the first one decodes the
     * wrong pair. The official selector's own note is that a row id is an opaque
     * key resolved by lookup and never parsed - JSON is how this page keeps that
     * promise while staying a single string.
     *
     * @param provider - the provider route.
     * @param model - the model id.
     * @returns the row id for the menu.
     */
    function modelRowId(provider, model) {
      return JSON.stringify([provider, model]);
    }

    /**
     * Decode a row id this page produced.
     *
     * Returns undefined for anything else, so a stale or foreign id is refused
     * rather than decoded into a pair that was never offered.
     *
     * @param id - the row id from the menu.
     * @returns the pair, or undefined when the id is not one of ours.
     */
    function decodeModelRowId(id) {
      var parsed;
      try {
        parsed = JSON.parse(id);
      } catch (error) {
        return undefined;
      }
      if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
      if (typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return undefined;
      return { provider: parsed[0], model: parsed[1] };
    }

    /**
     * Whether choosing `next` needs the explicit risk confirmation first.
     *
     * Only the widest preset does, and only when it is not already the value:
     * re-picking the preset already in force changes nothing, and asking for an
     * acknowledgement to confirm a no-op trains the user to click through the
     * dialog that matters.
     *
     * The check is a named function rather than an inline condition because it is
     * the one place that decides whether the approval cards get turned off, and
     * an inverted comparison there would fail silently.
     *
     * @param next - the preset being chosen.
     * @param current - the preset currently in force.
     * @returns whether the confirmation must be shown first.
     */
    function needsFullAccessConfirmation(next, current) {
      return next === 'danger-full-access' && current !== 'danger-full-access';
    }

    /**
     * The connection half: status, QR, verify code, sign-in and sign-out. */
    function Connection(props) {
      var t = props.t;
      var useState = React.useState;
      var useEffect = React.useEffect;
      var statusState = useState({ phase: 'idle' });
      var status = statusState[0];
      var setStatus = statusState[1];
      var codeState = useState('');
      var code = codeState[0];
      var setCode = codeState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = useState('');
      var error = errorState[0];
      var setError = errorState[1];

      // Polls while anything can still change. The attempt lives on the Host, so
      // closing and reopening this page resumes watching the same one rather than
      // starting a second; a settled attempt stops the timer, so an idle page
      // issues no requests.
      useEffect(function () {
        var stopped = false;
        var timer = null;
        function tick() {
          fetch(ROUTES.status, { cache: 'no-store' })
            .then(function (response) { return response.json(); })
            .then(function (next) {
              if (stopped) return;
              setStatus(next);
              var settled = next.phase === 'connected' || next.phase === 'already-connected'
                || next.phase === 'failed';
              // A stored login can be signed out from another tab, so the page
              // keeps a slow poll even when no attempt is running.
              if (!settled) timer = setTimeout(tick, 1000);
            })
            .catch(function () { if (!stopped) timer = setTimeout(tick, 2000); });
        }
        tick();
        return function () { stopped = true; if (timer !== null) clearTimeout(timer); };
      }, []);

      /** POST one action and fold the reported state back in. */
      function post(path, body) {
        setBusy(true);
        setError('');
        return fetch(path, { method: 'POST', body: body })
          .then(function (response) {
            return response.json().then(function (payload) {
              if (!response.ok) throw new Error(payload && payload.error ? payload.error : String(response.status));
              setStatus(payload);
            });
          })
          .catch(function (failure) {
            setError(String(failure && failure.message ? failure.message : failure));
          })
          .then(function () { setBusy(false); });
      }

      // A stored account with no live attempt is the ordinary steady state: the
      // boot connected whatever was stored long before this page opened.
      var account = status.accountId || status.storedAccountId;
      var phase = status.phase;
      var live = phase === 'waiting' || phase === 'scanned' || phase === 'need-verifycode';

      return h('section', { className: 'cw-card' },
        h('div', { className: 'cw-card-head' }, h('h3', { className: 'cw-card-title' }, t('connection'))),
        h('div', { className: 'cw-card-body' },
          account && !live
            ? h('p', { className: 'cw-ok' }, t('connectedAs', { account: account }))
            : h('p', { className: 'cw-muted' }, t('notConnected')),

          // While an attempt is live the status line, the code and its caption
          // form one left-aligned group, on the same edge as the status text
          // above them: the state change then moves nothing sideways.
          live
            ? h('div', { className: 'cw-qr-wrap' },
              h('p', { className: 'cw-muted' }, status.message || t(PHASE_KEY[phase] || 'waiting')),
              // The SVG endpoint re-renders per request, so a refreshed code
              // appears without this page tracking which one it holds.
              status.qrcodeUrl
                ? h('img', {
                  className: 'cw-qr',
                  alt: t('scan'),
                  src: ROUTES.qr + '?t=' + String(Date.now()),
                })
                : null,
            )
            : null,

          phase === 'need-verifycode'
            ? h('form', {
              className: 'cw-row',
              onSubmit: function (event) {
                event.preventDefault();
                if (code.trim() === '') return;
                var body = new URLSearchParams();
                body.set('code', code);
                post(ROUTES.verifyCode, body).then(function () { setCode(''); });
              },
            },
              h(Input, {
                value: code,
                inputMode: 'numeric',
                autoComplete: 'one-time-code',
                placeholder: t('needVerify'),
                'aria-label': t('needVerify'),
                onChange: function (event) { setCode(event.target.value); },
              }),
              h(Button, { variant: 'primary', size: 'sm', type: 'submit', disabled: busy }, t('submit')),
            )
            : null,

          !live
            ? h('div', { className: 'cw-row' },
              h(Button, {
                variant: 'primary',
                size: 'sm',
                disabled: busy,
                onClick: function () { post(ROUTES.begin, null); },
              }, account ? t('reconnect') : t('connect')),
              account
                ? h(Button, {
                  variant: 'outline',
                  size: 'sm',
                  disabled: busy,
                  onClick: function () {
                    if (!window.confirm(t('logoutConfirm'))) return;
                    post(ROUTES.logout, null);
                  },
                }, t('logout'))
                : null,
            )
            : null,

          phase === 'failed' ? h('p', { className: 'cw-err' }, status.message || t('failed')) : null,
          error ? h('p', { className: 'cw-err' }, error) : null,
        ),
      );
    }

    /**
     * The model picker: a dropdown over the models this deployment can run.
     *
     * The catalogue comes from the Host rather than from a list here, because a
     * hardcoded list goes stale and would offer models no adapter serves. It is
     * read once when the page mounts and never cached across opens: a provider
     * configured later has to show up, which is also why the Host route is
     * `no-store`.
     *
     * `Menu` is the primitives' own anchored dropdown, the same control the
     * official permission selector is built from, so this needs no styling of its
     * own to match the rest of the page.
     */
    function ModelField(props) {
      var t = props.t;
      var useState = React.useState;
      var useEffect = React.useEffect;
      var catalogState = useState({ status: 'loading', options: [], failures: [] });
      var catalog = catalogState[0];
      var setCatalog = catalogState[1];
      var openState = useState(false);
      var open = openState[0];
      var setOpen = openState[1];

      useEffect(function () {
        var stopped = false;
        fetch(ROUTES.models, { cache: 'no-store' })
          .then(function (response) {
            // A 501 is the Host saying it serves no catalogue at all, which is a
            // different thing from "no models are configured" and is reported as
            // such rather than shown as an empty list.
            if (!response.ok) throw new Error(String(response.status));
            return response.json();
          })
          .then(function (body) {
            if (stopped) return;
            setCatalog({ status: 'ready', options: body.options || [], failures: body.failures || [] });
          })
          .catch(function () {
            if (!stopped) setCatalog({ status: 'failed', options: [], failures: [] });
          });
        return function () { stopped = true; };
      }, []);

      // The configured pair is the value; a stored pair the catalogue no longer
      // offers still renders, so the user can see what is set instead of a
      // control that silently reads "follow the default".
      var current = props.provider === '' || props.model === ''
        ? null
        : { provider: props.provider, model: props.model };
      var rowId = current === null ? null : modelRowId(current.provider, current.model);
      var currentLabel = t('modelInherit');
      if (current !== null) {
        var match = null;
        for (var index = 0; index < catalog.options.length; index += 1) {
          var option = catalog.options[index];
          if (option.provider === current.provider && option.model === current.model) { match = option; break; }
        }
        currentLabel = match === null
          ? current.provider + ' / ' + current.model
          : match.providerLabel + ' · ' + match.label;
      }

      // The "follow the default" row is a selectable item carrying an empty id,
      // not a heading: choosing it is the reset gesture, and a heading cannot be
      // chosen. `onSelect` therefore receives `''` for it.
      var items = [{
        id: '',
        label: t('modelInherit'),
      }];
      for (var i = 0; i < catalog.options.length; i += 1) {
        var row = catalog.options[i];
        items.push({
          id: modelRowId(row.provider, row.model),
          label: row.providerLabel + ' · ' + row.label,
        });
      }
      // A stored pair the catalogue does not offer is offered back, so selecting
      // the row that is already set does not look like a no-op the user cannot
      // undo.
      if (rowId !== null && !catalog.options.some(function (option) {
        return option.provider === current.provider && option.model === current.model;
      })) {
        items.push({ id: rowId, label: current.provider + ' / ' + current.model });
      }
      var note = t('modelHint');
      if (catalog.status === 'loading') note = t('modelLoading');
      else if (catalog.status === 'failed') note = t('modelFailed');
      else if (catalog.options.length === 0) note = t('modelEmpty');

      return h('div', { className: 'cw-field' },
        h('div', { className: 'cw-head' },
          h('span', { className: 'cw-label' }, t('model')),
        ),
        h(Menu, {
          open: open,
          className: 'cw-menu',
          selectedId: rowId === null ? undefined : rowId,
          align: 'start',
          portal: true,
          onClose: function () { setOpen(false); },
          onSelect: function (id) {
            setOpen(false);
            // The "follow the default" row carries an empty id: choosing it is
            // the reset gesture, which clears both keys together.
            if (id === '') {
              props.onClear();
              return;
            }
            var pair = decodeModelRowId(id);
            // An id this page did not produce is refused rather than guessed at.
            if (pair === undefined) return;
            props.onPick(pair.provider, pair.model);
          },
          items: catalog.status === 'ready' && catalog.options.length > 0
            ? items
            : [{ id: '', label: note }],
          anchor: h(Button, {
            variant: 'outline',
            size: 'sm',
            disabled: props.disabled || catalog.status === 'loading',
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            onClick: function () { setOpen(!open); },
          }, currentLabel),
        }),
        h('p', { className: 'cw-hint' }, note),
        catalog.failures.length > 0
          ? h('p', { className: 'cw-hint' }, catalog.failures.map(function (failure) {
            return failure.provider;
          }).join(', ') + ' · ' + t('modelFailed'))
          : null,
      );
    }

    /**
     * The permission selector: the three presets, with an explicit risk
     * confirmation before the widest one.
     *
     * The confirmation is not decoration. `danger-full-access` bundles
     * `approval: never`, which the approval service settles *before* the
     * waterfall this plugin's WeChat approval cards join - so choosing it turns
     * those cards off entirely. The official page guards the same value the same
     * way, and the Host does not: `permissionPresets.set` has no risk gate of its
     * own, so a plugin that skipped this dialog could widen a session silently.
     */
    function PermissionField(props) {
      var t = props.t;
      var useState = React.useState;
      var confirmingState = useState(false);
      var confirming = confirmingState[0];
      var setConfirming = confirmingState[1];
      var acknowledgedState = useState(false);
      var acknowledged = acknowledgedState[0];
      var setAcknowledged = acknowledgedState[1];

      function choose(next) {
        if (needsFullAccessConfirmation(next, props.value)) {
          setAcknowledged(false);
          setConfirming(true);
          return;
        }
        props.onPick(next);
      }

      return h('div', { className: 'cw-field' },
        h('div', { className: 'cw-head' },
          h('span', { className: 'cw-label' }, t('permission')),
        ),
        h(SegmentedControl, {
          id: 'cw-permission',
          className: 'cw-segments',
          label: t('permission'),
          disabled: props.disabled,
          value: props.value,
          options: [
            { value: 'read-only', label: t('permissionReadOnly') },
            { value: 'workspace-write', label: t('permissionWorkspace') },
            { value: 'danger-full-access', label: t('permissionFull') },
          ],
          onChange: choose,
        }),
        h('p', { className: 'cw-hint' }, t('permissionHint')),
        h(RiskConfirmation, {
          open: confirming,
          title: t('permissionFullTitle'),
          description: t('permissionFullBody'),
          acknowledgeLabel: t('permissionFullAck'),
          cancelLabel: t('permissionFullCancel'),
          closeLabel: t('close'),
          confirmLabel: t('permissionFullConfirm'),
          acknowledged: acknowledged,
          disabled: props.disabled,
          onAcknowledgedChange: setAcknowledged,
          onCancel: function () { setAcknowledged(false); setConfirming(false); },
          onConfirm: function () {
            setAcknowledged(false);
            setConfirming(false);
            props.onPick('danger-full-access');
          },
        }),
      );
    }

    /**
     * The admission list, as a multi-line text control.
     *
     * A `textarea` rather than the primitives' `SettingsValueField`, which is a
     * single-line `<input>`: HTML strips newlines from an input's value, so the
     * documented "one id per line" cannot be typed into it at all. Worse, a
     * stored list would render as one collapsed line and be written back that
     * way on the next save - the operator's own id would stop matching and
     * nobody would be told.
     *
     * Hand-rolled like `PermissionField` above it, and for the same reason: the
     * primitive does not offer the control this field needs.
     */
    function AllowField(props) {
      var t = props.t;
      return h('div', { className: 'cw-field' },
        h('div', { className: 'cw-head' },
          h('label', { className: 'cw-label', htmlFor: 'cw-allow' }, t('allow')),
          props.overridden
            ? h(Button, {
              variant: 'ghost',
              size: 'sm',
              disabled: props.disabled,
              onClick: props.onReset,
            }, t('reset'))
            : null,
        ),
        h('textarea', {
          id: 'cw-allow',
          className: 'cw-textarea',
          rows: 3,
          spellCheck: false,
          autoComplete: 'off',
          disabled: props.disabled,
          value: props.text,
          placeholder: t('allowPlaceholder'),
          onChange: function (event) { props.onEdit(event.target.value); },
        }),
        h('p', { className: 'cw-hint' }, t('allowHint')),
      );
    }

    /** The configuration half: this plugin's own volatile fields. */
    function Config(props) {
      var t = props.t;
      // `SettingsFormModel` owns the drafts and writes them as one atomic
      // mutation fenced by the revision they were staged against, so two fields
      // cannot land separately.
      var state = props.useWechatConfig(function (snapshot) { return snapshot; });

      // The unavailable case is not handled here: `SettingsForm` renders the
      // `unavailable` line itself from `state.available`, and duplicating that
      // here would be two places to keep the same rule.
      var disabled = !state.writable;
      return h('section', { className: 'cw-card' },
        h('div', { className: 'cw-card-head' }, h('h3', { className: 'cw-card-title' }, t('config'))),
        h('div', { className: 'cw-card-body' },
          h(SettingsForm, {
            labels: formLabels(t),
            state: state,
            onSave: props.save,
            onDiscard: props.discard,
          },
            h(SettingsValueField, {
              id: 'cw-cwd',
              label: t('cwd'),
              hint: t('cwdHint'),
              overriddenLabel: t('overridden'),
              resetLabel: t('reset'),
              invalidLabel: t('cwdInvalid'),
              disabled: disabled,
              text: state.cwd.text,
              overridden: state.cwd.overridden,
              invalid: state.cwd.invalid,
              onEdit: function (text) { props.edit('cwd', text); },
              onReset: function () { props.resetField('cwd'); },
            }),
            // The enum uses the primitives' own segmented control rather than a
            // bare `<select>`: it is what the official settings pages use, it
            // carries the tablist keyboard semantics, and it needs no styling of
            // ours to match the rest of the page. The empty value is the reset
            // gesture, not a value.
            h('div', { className: 'cw-field' },
              // A `span`, not a `label`: the segmented control is a tablist that
              // carries its own accessible name (`label` below), and a `<label>`
              // pointing at no control would be the only unnamed element here.
              h('div', { className: 'cw-head' },
                h('span', { className: 'cw-label' }, t('cards')),
              ),
              h(SegmentedControl, {
                id: 'cw-cards',
                className: 'cw-segments',
                label: t('cards'),
                disabled: disabled,
                value: state.cards.text,
                options: [
                  { value: '', label: t('cardsInherit') },
                  { value: 'wechat', label: t('cardsWechat') },
                  { value: 'both', label: t('cardsBoth') },
                ],
                onChange: function (next) {
                  if (next === '') props.resetField('cards');
                  else props.edit('cards', next);
                },
              }),
              h('p', { className: 'cw-hint' }, t('cardsHint')),
            ),
            h(PermissionField, {
              t: t,
              value: state.permission.text,
              disabled: disabled,
              onPick: function (next) { props.edit('permission', next); },
            }),
            // Who may talk to this channel. A multi-line control, because the
            // documented format is one id per line and a single-line input
            // silently merges them. The empty value is meaningful - it admits
            // the account that scanned the login - which is why the hint says
            // so rather than leaving a blank field unexplained.
            h(AllowField, {
              t: t,
              text: state.allow.text,
              overridden: state.allow.overridden,
              disabled: disabled,
              onEdit: function (text) { props.edit('allow', text); },
              onReset: function () { props.resetField('allow'); },
            }),
            h(ModelField, {
              t: t,
              provider: state.provider.text,
              model: state.model.text,
              disabled: disabled,
              onPick: function (provider, model) {
                props.edit('provider', provider);
                props.edit('model', model);
              },
              onClear: function () {
                props.resetField('provider');
                props.resetField('model');
              },
            }),
          ),
        ),
      );
    }

    /**
     * The version card: what is running, whether something newer exists, and the
     * two ways to update.
     *
     * This card deliberately offers no "update now" button. Measured: the
     * in-process plugin manager refuses to replace an installed package
     * (`already-installed` while HMR is present, which the shipped bundles always
     * provide), and its remove path can leave the package installed but the
     * bundle deselected - a state the user is never told about. The CLI has
     * neither problem, so the card hands over the command instead of pretending
     * to do something it cannot do safely.
     */
    function UpdateCard(props) {
      var t = props.t;
      var useState = React.useState;
      // idle | checking | ready | failed
      var stateState = useState({ phase: 'idle' });
      var state = stateState[0];
      var setState = stateState[1];
      var commandState = useState(null);
      var command = commandState[0];
      var setCommand = commandState[1];
      var copiedState = useState('');
      var copied = copiedState[0];
      var setCopied = copiedState[1];

      /**
       * Ask the Host to read the registry, then fetch instructions if there is an
       * upgrade.
       *
       * Deliberately not run on mount. A check nobody asked for is one more
       * request on every page open, and it answers a question - "is there a newer
       * release?" - the user has not posed. The button is the only trigger, which
       * is also why the Host keeps no cache: a press means "ask now", so a release
       * published a minute ago is visible on the next press rather than five
       * minutes later.
       */
      function check() {
        setState({ phase: 'checking' });
        // The command belongs to the version that was current when it was built,
        // so a result from an earlier press must not outlive the next one.
        setCommand(null);
        setCopied('');
        fetch(ROUTES.updateCheck, { cache: 'no-store' })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            setState({ phase: 'ready', check: body });
            // Only an actual upgrade needs a command; fetching one otherwise
            // would ask the Host to prepare instructions nobody sees.
            if (body.status === 'ready' && body.newer) {
              return fetch(ROUTES.updateCommand, { cache: 'no-store' })
                .then(function (response) { return response.ok ? response.json() : null; })
                .then(function (value) { if (value !== null) setCommand(value); });
            }
          })
          .catch(function (failure) {
            setState({ phase: 'failed', reason: String(failure && failure.message ? failure.message : failure) });
          });
      }

      /**
       * Put the command on the clipboard.
       *
       * `navigator.clipboard` needs a secure context, which a `http://127.0.0.1`
       * page has; a plain-HTTP page on another host does not. The fallback
       * reports that the copy failed rather than showing "已复制" over an empty
       * clipboard, so the user knows to select the text themselves.
       */
      function copy(text) {
        var done = function () { setCopied('copied'); };
        var failed = function () { setCopied('failed'); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, failed);
          return;
        }
        failed();
      }

      var body = null;
      if (state.phase === 'checking') {
        body = h('p', { className: 'cw-muted' }, t('checking'));
      } else if (state.phase === 'failed') {
        body = h('p', { className: 'cw-err' }, t('updateFailed', { reason: state.reason }));
      } else if (state.phase === 'ready') {
        if (state.check.status === 'failed') {
          // The Host answered but the registry could not be read. Kept distinct
          // from "up to date": one is the user's network, the other is the truth.
          body = h('p', { className: 'cw-err' }, t('updateFailed', { reason: state.check.reason }));
        } else if (!state.check.newer) {
          body = h('p', { className: 'cw-ok' }, t('upToDate', { version: state.check.current }));
        } else {
          body = h('div', { className: 'cw-update' },
            h('p', { className: 'cw-muted' }, t('updateAvailable', {
              latest: state.check.latest,
              current: state.check.current,
            })),
            h('p', { className: 'cw-muted' }, t('updateHowTo')),

            // The command goes first because it is the one that works without the
            // user hunting through the GUI, and it is the only one that can be
            // copied. It is also the only way on a profile whose plugin list the
            // GUI cannot reach.
            h('div', { className: 'cw-way' },
              h('p', { className: 'cw-way-title' }, t('updateWay1')),
              command === null
                ? h('p', { className: 'cw-hint' }, t('updateNoCommand'))
                : h('div', { className: 'cw-cmd-wrap' },
                  h('pre', { className: 'cw-cmd' }, command.command),
                  h(Button, {
                    variant: 'outline',
                    size: 'sm',
                    onClick: function () { copy(command.command); },
                  }, copied === 'copied' ? t('copied') : copied === 'failed' ? t('copyFailed') : t('copy')),
                ),
              // Two facts the command alone does not convey, and each one is the
              // difference between a working update and a refused one.
              h('p', { className: 'cw-hint' }, t('updateExitFirst')),
              h('p', { className: 'cw-hint' }, t('updateAgeNote')),
              command !== null && command.desktop ? h('p', { className: 'cw-hint' }, t('updateDesktopNote')) : null,
            ),

            h('div', { className: 'cw-way' },
              h('p', { className: 'cw-way-title' }, t('updateWay2', { spec: state.check.latest })),
            ),
          );
        }
      }

      return h('section', { className: 'cw-card' },
        h('div', { className: 'cw-card-head cw-card-head--action' },
          h('h3', { className: 'cw-card-title' }, t('version')),
          h('div', { className: 'cw-card-action' },
            // Shown only once the Host has answered, because the running version
            // is read from the installed manifest there. A placeholder would be a
            // number the page guessed at.
            state.phase === 'ready' && state.check.status === 'ready'
              ? h('span', { className: 'cw-version' }, t('currentVersion', { version: state.check.current }))
              : null,
            // The only thing that reads the registry. Disabled while a press is
            // in flight, so a second press cannot race the first one's answer.
            h(Button, {
              variant: 'outline',
              size: 'sm',
              disabled: state.phase === 'checking',
              onClick: check,
            }, t('checkUpdate')),
          ),
        ),
        body === null ? null : h('div', { className: 'cw-card-body' }, body),
      );
    }

    /** The page: connection above, configuration below. */
    function WechatPage(props) {
      return h('div', { className: 'cw-root' },
        h(Connection, { t: props.t }),
        h(Config, {
          t: props.t,
          useWechatConfig: props.useWechatConfig,
          edit: props.edit,
          resetField: props.resetField,
          save: props.save,
          discard: props.discard,
        }),
        // Last on the page: an update is a rare, deliberate action, so it does
        // not compete with the scan and the settings for the first screen.
        h(UpdateCard, { t: props.t }),
      );
    }

    /** This plugin's card stylesheet. */
    var CSS = [
      // Apple's grouped-inset rhythm, expressed in the tokens the theme already
      // has: a card per group, a gap between groups roughly twice the gap
      // between the lines inside one, and hierarchy carried by size and space
      // rather than by weight. The theme's `corner-shape: superellipse(1.5)`
      // applies to these radii on its own, so the corners are squircles.
      '.cw-root{display:flex;flex-direction:column;gap:28px;}',
      '.cw-card{display:flex;flex-direction:column;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);overflow:hidden;}',
      '.cw-card-head{padding:20px 20px 4px;}',
      // The version card's head carries a button, so it becomes a row: the title
      // keeps the left edge, and the version chip and the button share the right
      // one. Wrapping keeps the button off the title's baseline.
      '.cw-card-head--action{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-bottom:8px;}',
      '.cw-card-action{display:flex;align-items:center;gap:12px;margin-left:auto;}',
      // 16px/500, not the page's 13px/600: a group heading earns its rank from
      // size and the space under it, the way the panel's own headings do.
      '.cw-card-title{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary);}',
      '.cw-card-body{display:flex;flex-direction:column;gap:14px;padding:12px 20px 20px;}',
      '.cw-muted{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6;}',
      '.cw-ok{margin:0;color:var(--dsw-alias-state-success-primary);font-size:13px;line-height:1.6;}',
      '.cw-err{margin:0;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:1.6;}',
      // The field owns the 6px gap above a caption; no negative margin here, or
      // the hint would ride up over the control it describes.
      '.cw-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;}',
      '.cw-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
      // Left-aligned with the status line and the card's own padding, so the
      // scan instruction sits on the same edge as everything else in the card
      // instead of jumping to the middle when the state changes.
      '.cw-qr-wrap{display:flex;flex-direction:column;align-items:flex-start;gap:12px;padding:8px 0 4px;}',
      // A step up from the 200px first shipped: still a small code block beside
      // the card's text, but big enough that the modules resolve at arm's length.
      '.cw-qr{width:224px;height:224px;border-radius:var(--dsw-radius-lg);background:var(--dsw-static-neutral-00);padding:10px;box-sizing:border-box;box-shadow:var(--dsw-elevation-soft);}',
      // Matches the primitives' own field rhythm: the same vertical padding and
      // hairline the `SettingsValueField` above it draws, so the two controls
      // read as one form rather than a control beside a hand-rolled widget.
      '.cw-field{display:flex;flex-direction:column;gap:6px;padding:12px 0;border-top:0.5px solid var(--dsw-alias-border-l2);}',
      '.cw-head{display:flex;align-items:center;gap:8px;}',
      '.cw-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary);}',
      // The segmented control sizes to its labels; left-aligned it sits under the
      // input above instead of stretching across the panel. Only the tab is
      // resized, never the track: the sliding indicator derives its own height
      // from the control's padding and its own width from the segment count, so
      // shrinking the track would need that arithmetic duplicated here and would
      // drift by a pixel the moment either changed.
      '.cw-segments{align-self:flex-start;}',
      '.cw-segments [role="tab"]{height:24px;padding:0 12px;font-size:12px;line-height:18px;}',
      // The model trigger sits under its label on the same left edge as the
      // segmented controls, so the three fields read as one column.
      '.cw-field .cw-menu{align-self:flex-start;}',
      // The admission list. Sized like the primitives' own text input (34px for
      // one line) but tolerant of several: ids are pasted a column at a time, and
      // a control that showed one line at a time would hide what is configured.
      // `resize: vertical` only, so the page's width stays its own.
      '.cw-textarea{box-sizing:border-box;min-height:60px;padding:6px 12px;resize:vertical;',
      'border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);',
      'background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;',
      'color:var(--dsw-alias-label-primary);}',
      '.cw-textarea:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary);}',
      '.cw-textarea:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;}',
      // The version card: a heading that carries the running version beside it,
      // the way the other cards carry only a title.
      '.cw-version{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;}',
      '.cw-update{display:flex;flex-direction:column;gap:12px;}',
      // Each way is its own block with a top rule: the two options are separate
      // instructions, not a paragraph. The rule is the same hairline the settings
      // fields use, so the card reads as the same family.
      '.cw-way{display:flex;flex-direction:column;gap:8px;padding-top:12px;border-top:0.5px solid var(--dsw-alias-border-l2);}',
      '.cw-way-title{margin:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary);}',
      // The command scrolls rather than wrapping: a wrapped shell line is a
      // command a user is likely to copy with a stray newline in the middle.
      '.cw-cmd-wrap{display:flex;flex-direction:column;gap:8px;align-items:flex-start;}',
      '.cw-cmd{margin:0;padding:10px 12px;max-width:100%;overflow-x:auto;box-sizing:border-box;',
      'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);',
      'border-radius:var(--dsw-radius-lg);white-space:pre;}',
    ].join('');

    /**
     * Bridge the `channel-wechat` settings scope onto the page's staged form.
     *
     * Built once when the page registers, not per render: the model subscribes
     * to the scope on construction and owns the drafts, so a second one would
     * hold a second copy of them. The snapshot store is what the renderer binds
     * to the component's `useWechatConfig` selector hook.
     */
    function createCard(ctx) {
      var model = new SettingsFormModel(ctx.configForms.get(NS), [
        settingsPathField('cwd'),
        settingsEnumField('cards', ['wechat', 'both']),
        settingsEnumField('permission', ['read-only', 'workspace-write', 'danger-full-access']),
        settingsTextValueField('provider'),
        settingsTextValueField('model'),
        // One string, not an array: the form model writes single-segment paths,
        // so a nested list could not be saved back. The value's own newlines are
        // what separate ids, which is why the control above is a textarea.
        settingsTextValueField('allow'),
      ]);
      var store = model.bind(function () {
        var shell = model.shell();
        // The shell carries the form-level facts; each field's draft rides
        // beside them, which is what `{...state.cwd}` spreads in the component.
        shell.cwd = model.field('cwd');
        shell.cards = model.field('cards');
        shell.permission = model.field('permission');
        shell.provider = model.field('provider');
        shell.model = model.field('model');
        shell.allow = model.field('allow');
        return shell;
      });
      return { model: model, store: store };
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply: function (ctx) {
        ctx.effect(function () {
          return ctx.locale.register(LOCALE_NS, DICT);
        }, 'channel-wechat: dictionaries');

        // Tagged with the plugin id so the loader can remove the stylesheet when
        // the plugin is switched off; an untagged tag would outlive the page.
        ctx.effect(function () {
          if (typeof document === 'undefined') return function () {};
          var tag = document.createElement('style');
          tag.dataset.plugin = PLUGIN_ID;
          tag.dataset.pluginCss = PLUGIN_ID + '/client.js';
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return function () { tag.remove(); };
        }, 'channel-wechat: card styles');

        var t = ctx.locale.bind(LOCALE_NS);
        var card = createCard(ctx);
        ctx.effect(function () {
          return function () { card.model.dispose(); };
        }, 'channel-wechat: form subscription');

        var actions = card.model.actions();

        // The page exists exactly while the Host serves the namespace. A
        // deployment that composes no settings service therefore shows no trace
        // of it, rather than a page whose fields could never load.
        //
        // `plugins.bundle.config` is keyed by the bundle's package name, which is
        // why the bundling itself cannot be renamed independently of `id` below:
        // a key that does not match leaves the page registered and never
        // rendered, with no error.
        ctx.effect(function () {
          return ctx.configForms.whileServed([NS], function () {
            return ctx.slots.inject('plugins.bundle.config', function () {
              return ctx.slots.register({
                name: 'plugins.bundle.config',
                key: PLUGIN_ID,
                locale: LOCALE_NS,
                inject: function () {
                  // The reserved `hooks` compartment: the renderer turns each
                  // source into a `use<Name>` selector hook on the component, so
                  // this one arrives as `useWechatConfig`.
                  return {
                    hooks: { wechatConfig: card.store },
                    edit: actions.edit,
                    resetField: actions.resetField,
                    save: actions.save,
                    discard: actions.discard,
                  };
                },
              }, WechatPage);
            });
          });
        }, 'channel-wechat: page');
      },
    };
  },
});
