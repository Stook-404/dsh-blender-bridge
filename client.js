/**
 * dsh-blender-bridge 客户端模块（v4）
 * 依据 Console 实测：sidebarRightTabs 服务可用(tabs=true)，path A 需 inject:['slots']。
 */
(() => {
  try { console.log('[dsh-blender-bridge] client module loaded'); } catch {}
  const TAB_ID = 'dsh-blender-bridge';
  const TAB_KIND = 'blender-bridge';
  const SLOT = 'sidebar.right.pane.tab';
  const PANEL = '/blender-bridge/panel';

  window.__ModuleLoader__.load({
    id: 'dsh-blender-bridge',
    factory: (require2) => {
      const React = require2('react');

      function BlenderPanel() {
        return React.createElement('iframe', {
          src: PANEL,
          title: 'Blender',
          style: { width: '100%', height: '100%', minHeight: '420px', border: '0', display: 'block', background: '#0f1115' },
        });
      }

      return {
        name: 'dsh-blender-bridge',
        inject: ['slots'],
        apply(ctx) {
          try { console.log('[dsh-blender-bridge] apply called'); } catch {}
          const meta = { name: SLOT, key: TAB_ID, inject: () => ({ inSidebar: true }) };

          try {
            ctx.slots.register(meta, BlenderPanel);
            try { console.log('[dsh-blender-bridge] path A ok'); } catch {}
          } catch (e) {
            try { console.warn('[dsh-blender-bridge] path A failed:', e && e.message); } catch {}
          }

          try {
            ctx.inject(['sidebarRightTabs'], (owner) => {
              const tabs = owner.get('sidebarRightTabs');
              const hasSlots = !!(owner.slots && owner.slots.register);
              try { console.log('[dsh-blender-bridge] path B tabs=', !!tabs, 'owner.slots=', hasSlots); } catch {}
              if (tabs && typeof tabs.register === 'function') {
                owner.effect(() => tabs.register({
                  id: TAB_ID, kind: TAB_KIND, priority: 'extension',
                  title: () => 'Blender', guide: [{ order: 120, title: () => 'Blender' }],
                }), 'dsh-blender-bridge: sidebar tab type');
                try { console.log('[dsh-blender-bridge] path B tab type registered'); } catch {}
              }
              if (hasSlots) {
                const r = owner.slots.register.bind(owner.slots);
                owner.slots.inject(SLOT, () => r(meta, BlenderPanel));
                try { console.log('[dsh-blender-bridge] path B slot injected'); } catch {}
              } else {
                try { console.warn('[dsh-blender-bridge] path B: owner.slots missing'); } catch {}
              }
            });
          } catch (e) {
            try { console.warn('[dsh-blender-bridge] path B failed:', e && e.message); } catch {}
          }
        },
      };
    },
  });
})();
