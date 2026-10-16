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
        unavailable: '此部署未提供设置服务。',
        readOnly: '当前连接的设置文档为只读。',
        saveFailed: '保存未被接受。',
        save: '保存',
        saving: '保存中…',
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
        unavailable: 'This deployment serves no settings.',
        readOnly: 'The connected settings document is read-only.',
        saveFailed: 'The save was not accepted.',
        save: 'Save',
        saving: 'Saving…',
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
          return trimmed.charAt(0) === '/' ? { kind: 'set', value: trimmed } : undefined;
        },
      };
    }

    /** The connection half: status, QR, verify code, sign-in and sign-out. */
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

      return h('section', { className: 'cw-section' },
        h('h3', { className: 'cw-h3' }, t('connection')),
        account && !live
          ? h('p', { className: 'cw-ok' }, t('connectedAs', { account: account }))
          : h('p', { className: 'cw-muted' }, t('notConnected')),

        live ? h('p', { className: 'cw-muted' }, status.message || t(PHASE_KEY[phase] || 'waiting')) : null,

        // The SVG endpoint re-renders per request, so a refreshed code appears
        // without this page tracking which one it holds.
        live && status.qrcodeUrl
          ? h('img', {
            className: 'cw-qr',
            alt: t('scan'),
            src: ROUTES.qr + '?t=' + String(Date.now()),
          })
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
            h(Button, { variant: 'primary', type: 'submit', disabled: busy }, t('submit')),
          )
          : null,

        !live
          ? h('div', { className: 'cw-row' },
            h(Button, {
              variant: 'primary',
              disabled: busy,
              onClick: function () { post(ROUTES.begin, null); },
            }, account ? t('reconnect') : t('connect')),
            account
              ? h(Button, {
                variant: 'outline',
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
      return h('section', { className: 'cw-section' },
        h('h3', { className: 'cw-h3' }, t('config')),
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
        ),
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
      );
    }

    /** This plugin's card stylesheet. */
    var CSS = [
      '.cw-root{display:flex;flex-direction:column;gap:20px;}',
      '.cw-section{display:flex;flex-direction:column;gap:8px;}',
      '.cw-h3{font-size:13px;font-weight:600;margin:0;color:var(--dsw-alias-label-secondary);}',
      '.cw-muted{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6;}',
      '.cw-ok{margin:0;color:var(--dsw-alias-state-success-primary);font-size:13px;}',
      '.cw-err{margin:0;color:var(--dsw-alias-state-error-primary);font-size:13px;}',
      '.cw-hint{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;}',
      '.cw-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
      '.cw-qr{width:200px;height:200px;border-radius:var(--dsw-radius-md);background:#fff;padding:8px;box-sizing:border-box;}',
      // Matches the primitives' own field rhythm: the same vertical padding and
      // hairline the `SettingsValueField` above it draws, so the two controls
      // read as one form rather than a control beside a hand-rolled widget.
      '.cw-field{display:flex;flex-direction:column;gap:6px;padding:12px 0;border-top:0.5px solid var(--dsw-alias-border-l2);}',
      '.cw-head{display:flex;align-items:center;gap:8px;}',
      '.cw-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary);}',
      // The segmented control sizes to its labels; left-aligned it sits under the
      // input above instead of stretching across the panel.
      '.cw-segments{align-self:flex-start;}',
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
      ]);
      var store = model.bind(function () {
        var shell = model.shell();
        // The shell carries the form-level facts; each field's draft rides
        // beside them, which is what `{...state.cwd}` spreads in the component.
        shell.cwd = model.field('cwd');
        shell.cards = model.field('cards');
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
