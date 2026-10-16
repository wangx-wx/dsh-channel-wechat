window.__ModuleLoader__.load({
  id: 'dsh-channel-wechat',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    function Probe() {
      return h('p', null, 'dsh-channel-wechat client half loaded');
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab', id: 'channel-wechat', order: 50, label: 'WeChat',
        }, Probe));
      },
    };
  },
});
