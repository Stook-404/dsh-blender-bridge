/**
 * dsh-blender-bridge · client
 *
 * 在右侧栏注册一个「Blender」标签页，内容为 /blender-bridge/panel 面板。
 *
 * 注册方式（照 dsh-plugin-wallpaper-engine 的可用实现）：
 *   1. 服务必须通过 ctx.inject([...], owner => ...) 的子 ctx 获取。
 *      - ctx.get('slots') 在插件根 ctx 上返回 undefined，取不到服务。
 *      - 在模块级写 inject: ['slots'] 会让插件在缺该服务的宿主上被 park，
 *        apply 根本不执行。
 *   2. 两段注册：
 *      - tab 类型：sidebarRightTabs.register({ id, kind, keepMounted, title, guide })
 *        guide 条目需带 id 与 description，否则菜单不显示。
 *      - tab 身体：slots.register({ name: 'sidebar.right.pane.tab', key: id }, Component)
 *   3. 任何服务取不到时静默退出，绝不影响宿主界面。
 */
(() => {
  const ID = 'dsh-blender-bridge';
  const KIND = 'blender-bridge';
  const SLOT = 'sidebar.right.pane.tab';
  const PANEL = '/blender-bridge/panel';

  window.__ModuleLoader__.load({
    id: ID,
    factory: (require2) => {
      const React = require2('react');

      function BlenderPanel() {
        return React.createElement('iframe', {
          src: PANEL,
          title: 'Blender',
          style: {
            width: '100%',
            height: '100%',
            minHeight: '420px',
            border: '0',
            display: 'block',
            background: '#0f1115',
          },
        });
      }

      return {
        name: ID,
        inject: [],
        apply(ctx) {
          try {
            ctx.inject(['sidebarRightTabs', 'slots'], (owner) => {
              const tabs = owner.get('sidebarRightTabs');
              const slots = owner.get('slots') || owner.slots;

              if (tabs && typeof tabs.register === 'function') {
                try {
                  tabs.register({
                    id: ID,
                    kind: KIND,
                    keepMounted: true,
                    title: () => 'Blender',
                    guide: [{
                      id: 'panel',
                      order: 120,
                      title: () => 'Blender',
                      description: () => '用 Blender 建模并预览',
                    }],
                  });
                } catch { /* 宿主不支持该能力，降级 */ }
              }

              if (slots && typeof slots.register === 'function') {
                try {
                  slots.register({ name: SLOT, key: ID }, BlenderPanel);
                } catch { /* 同上 */ }
              }
            });
          } catch { /* 服务不可用：只保留工具与面板 URL，不影响宿主 */ }
        },
      };
    },
  });
})();
