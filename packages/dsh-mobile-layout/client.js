window.__ModuleLoader__.load({
  id: '@local/dsh-mobile-layout',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /**
     * Phone widths only. The layout store auto-collapses to the 56px rail below
     * 1024px; from 768px up the stock rail and side panels fit, so they stay.
     */
    const PHONE_MAX = 767;
    /** Touch minimum target. */
    const TOUCH = 44;
    /** Widest the drawer gets. */
    const DRAWER_MAX = 320;

    /**
     * Markers this plugin owns.
     *
     * `MENU` is on the fixed menu button. `FRAME` marks the grid frame, found
     * structurally (the overlay layer's parent), and `DRAWER` the sidebar column
     * while open. Layout rules key on these markers, and the button only shows
     * while `FRAME` exists, so a DSH update that moves the shell leaves the stock
     * rail in place instead of a button over a half-styled layout.
     */
    const MENU = 'data-dsh-mobile-menu';
    const FRAME = 'data-dsh-mobile-frame';
    const DRAWER = 'data-dsh-mobile-drawer';
    const CSS = 'data-dsh-mobile-css';
    const INSET = 'data-dsh-mobile-inset';

    // Hashed shell class names, stable for the installed DSH version. Only
    // cosmetic rules and the column lookup's first choice use them.
    const C = {
      sidebarCol: 'pI_x6G_sidebarCol',
      centerCol: 'pI_x6G_centerCol',
      panelTitle: 'hHd-Xa_panelTitle'
    };

    /**
     * The stylesheet.
     *
     * Phone widths only; desktop is untouched because every rule sits inside the
     * media query and the button is display:none at desktop widths.
     *
     * The frame's grid tracks are set inline by the layout solve, so the override
     * needs !important to win. It reproduces the closed-sidebar solve with a zero
     * first track; the fixed drawer leaves the grid flow entirely.
     */
    const STYLE = `
.dsh-ml-navcontrols { display: none; }
@media (max-width: ${PHONE_MAX}px) {
  /* A) The collapsed rail's 56px track becomes 0, but only while the menu button
     (fail-safe) and the collapsed state are both present in the DOM. */
  html:has([${MENU}]) [${FRAME}][data-sidebar-collapsed="true"],
  html:has([${MENU}]) [${FRAME}][data-dsh-mobile-open] {
    grid-template-columns: 0px minmax(0px, 1fr) minmax(0px, 0px) !important;
  }
  /* Headers leave room for the fixed menu button instead of sitting under it.
     The conversation header already honours the shell's own leading-clearance
     variable (padding-inline-start: var - 20px); global panels mounted in the
     main slot get the same inset on their top row. Keyed on the button. */
  html:has([${MENU}]) [${FRAME}] {
    --dsh-frame-leading-clearance: calc(env(safe-area-inset-left, 0px) + ${8 + TOUCH + 12}px);
  }
  html:has([${MENU}]) [${FRAME}] [${INSET}] {
    padding-inline-start: calc(env(safe-area-inset-left, 0px) + ${8 + TOUCH + 4}px) !important;
    box-sizing: border-box;
  }
  html:has([${MENU}]) [${FRAME}]:is([data-sidebar-collapsed="true"], [data-dsh-mobile-open]) > :nth-child(2) { grid-column: 2; }
  html:has([${MENU}]) [${FRAME}]:is([data-sidebar-collapsed="true"], [data-dsh-mobile-open]) > :nth-child(3) { grid-column: 3; }

  /* The drawer: the sidebar column floats over the conversation while open. */
  html:has([${MENU}]) [${FRAME}][data-dsh-mobile-open] [${DRAWER}] {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 40;
    width: min(${DRAWER_MAX}px, 84vw);
    box-shadow: 0 8px 40px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent);
    animation: dsh-ml-in 0.18s var(--ds-ease-in-out, ease);
  }
  /* The shell passes its desktop width preference inline to SidebarRoot.
     The fixed phone overlay has a different width: fill that actual containing
     block, preserving the root's stock 12px padding and scroll-region gutters. */
  html:has([${MENU}]) [${DRAWER}] .hHd-Xa_root {
    width: 100% !important;
    max-width: 100%;
    box-sizing: border-box;
  }

  /* The original navigation is the only panel list. Closed means display:none,
     not a second visually-hidden set of focusable buttons. */
  html:has([${MENU}]) [data-dsh-mobile-nav] { display: none; }
  html:has([${MENU}]) .dsh-ml-navcontrols {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 8px;
    margin-bottom: 8px;
  }
  html:has([${MENU}]) .dsh-ml-navcontrols button,
  html:has([${MENU}]) [data-dsh-mobile-nav] > button {
    min-width: 44px;
    min-height: 44px;
    height: auto;
    box-sizing: border-box;
    padding: 10px 12px;
    margin: 0;
    color: var(--dsw-alias-label-primary);
    background: var(--dsw-alias-bg-layer-1);
    border: 0;
    border-radius: var(--dsw-radius-md, 8px);
    font: inherit;
    white-space: normal;
    overflow-wrap: anywhere;
    cursor: pointer;
  }
  html:has([${MENU}]) [data-dsh-mobile-nav][data-open] {
    display: flex;
    flex-direction: column;
    gap: 8px;
    position: absolute;
    z-index: 50;
    top: calc(env(safe-area-inset-top, 0px) + 64px);
    inset-inline: 8px;
    max-height: calc(100dvh - env(safe-area-inset-top, 0px) - 88px);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 8px;
    margin: 0;
    background: var(--dsw-specific-sidebar-fill);
    border: 1px solid var(--dsw-alias-border-l3);
    border-radius: var(--dsw-radius-md, 8px);
    box-shadow: 0 8px 28px #0005;
  }
  html:has([${MENU}]) [data-dsh-mobile-nav] > button { flex: none; width: 100%; }
  html:has([${MENU}]) [data-dsh-mobile-nav] .${C.panelTitle} {
    white-space: normal;
    overflow: visible;
    overflow-wrap: anywhere;
  }
  html:has([${MENU}]) [${DRAWER}] .hHd-Xa_logoRow {
    padding-inline-start: calc(env(safe-area-inset-left, 0px) + 56px);
  }
  html:has([${MENU}]) .hHd-Xa_moreMenu { max-width: calc(100vw - 24px); }
  html:has([${MENU}]) .hHd-Xa_moreMenu [role="menuitem"] {
    min-height: 44px;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  /* B) The menu button: fixed top-left inside the safe area, above everything,
     and only once the frame has been found and marked. */
  html:has([${FRAME}]) [${MENU}] {
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 8px);
    left: calc(env(safe-area-inset-left, 0px) + 8px);
    z-index: 60;
    width: ${TOUCH}px;
    height: ${TOUCH}px;
    border: none;
    border-radius: var(--dsw-radius-md, 8px);
    background: transparent;
    color: var(--dsw-alias-label-primary, currentColor);
    cursor: pointer;
    align-items: center;
    justify-content: center;
    padding: 0;
    display: inline-flex;
  }
  html:has([${FRAME}]) [${MENU}]:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.2)); }
  html:has([${FRAME}]) [${MENU}]:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary, currentColor); }
}

/* Hidden unless the phone rule above shows it: desktop, tablet and an
   unrecognised shell all keep the layout exactly as shipped. */
[${MENU}] { display: none; }

.dsh-ml-scrim {
  position: fixed;
  inset: 0;
  z-index: 39;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.24));
  animation: dsh-ml-fade 0.18s var(--ds-ease-in-out, ease);
}
@keyframes dsh-ml-in { from { transform: translateX(-100%); } to { transform: none; } }
@keyframes dsh-ml-fade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  html:has([${MENU}]) [${FRAME}][data-dsh-mobile-open] [${DRAWER}],
  .dsh-ml-scrim { animation: none; }
}
`;

    /** Install the stylesheet once for this document; returns its removal. */
    function installCss() {
      if (document.querySelector(`style[${CSS}]`)) return () => {};
      const style = document.createElement('style');
      style.setAttribute(CSS, '');
      style.textContent = STYLE;
      document.head.appendChild(style);
      return () => style.remove();
    }

    /** The frame element, found structurally: the overlay layer's parent. */
    function frameEl() {
      const overlay = document.querySelector('[data-shell-overlay], .pI_x6G_overlayLayer');
      return overlay ? overlay.parentElement : null;
    }

    /** True while the frame reports the collapsed (rail) state. */
    function collapsed(frame) {
      return Boolean(frame && frame.getAttribute('data-sidebar-collapsed') === 'true');
    }

    /** True while this plugin has marked the drawer open. */
    function drawerOpen() {
      const frame = frameEl();
      return Boolean(frame && frame.hasAttribute('data-dsh-mobile-open'));
    }

    /** Every marker this plugin wrote, cleared together. */
    function clearMarks() {
      const frame = frameEl();
      if (!frame) return;
      frame.removeAttribute(FRAME);
      frame.removeAttribute('data-dsh-mobile-open');
      const column = frame.querySelector('.' + C.sidebarCol) || frame.firstElementChild;
      if (column) column.removeAttribute(DRAWER);
    }

    /**
     * Keep the open/closed markers in step with the frame's own collapsed attribute.
     * @returns the disposer.
     */
    function watchDrawer() {
      let raf = 0;
      let wasOpen = false;
      const apply = () => {
        raf = 0;
        const frame = frameEl();
        const btn = document.querySelector(`[${MENU}]`);
        if (!frame) return;
        const phone = window.innerWidth <= PHONE_MAX;
        const open = phone && !collapsed(frame);
        if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (phone) frame.setAttribute(FRAME, ''); else frame.removeAttribute(FRAME);
        const column = frame.querySelector('.' + C.sidebarCol) || frame.firstElementChild;
        if (open) {
          frame.setAttribute('data-dsh-mobile-open', '');
          if (column) column.setAttribute(DRAWER, '');
        } else {
          if (column) column.removeAttribute(DRAWER);
          if (collapsed(frame) || !phone) frame.removeAttribute('data-dsh-mobile-open');
        }
        // Focus follows the drawer: into it when the menu button opened it, and
        // back to the button when it closes with focus inside.
        if (open && !wasOpen && btn && document.activeElement === btn && column) {
          column.querySelector('button, a[href], input, [tabindex]:not([tabindex="-1"])')?.focus();
        } else if (!open && wasOpen && btn && column && column.contains(document.activeElement)) {
          btn.focus();
        }
        wasOpen = open;
      };
      const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };
      // Only the collapse attribute and shell re-renders matter; a page-wide
      // `class` filter woke this on every class change in the app.
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ['data-sidebar-collapsed']
      });
      window.addEventListener('resize', schedule);
      apply();
      return () => {
        observer.disconnect();
        window.removeEventListener('resize', schedule);
        if (raf) cancelAnimationFrame(raf);
        clearMarks();
      };
    }

    /** Keep the stock panel actions, including More's portalled discovery menu.
     * Only one accessible list exists; the disclosure changes its presentation.
     * Cordis exposes selectPanel but no public panel-catalog Service, so the live
     * sidebar is the installed/localized source of truth, not a hardcoded list. */
    function mountPanelDisclosure() {
      let mounted = null;
      let raf = 0;
      const sync = () => {
        raf = 0;
        const nav = window.innerWidth <= PHONE_MAX && drawerOpen()
          ? document.querySelector(`[${DRAWER}] nav`) : null;
        if (mounted?.nav === nav) return;
        mounted?.dispose();
        mounted = null;
        if (!nav) return;
        const controls = document.createElement('div');
        controls.className = 'dsh-ml-navcontrols';
        const direct = document.createElement('button');
        direct.type = 'button';
        direct.textContent = 'mAgent';
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.textContent = 'Panels';
        trigger.setAttribute('aria-expanded', 'false');
        const previousId = nav.getAttribute('id');
        nav.id = 'dsh-mobile-panels';
        trigger.setAttribute('aria-controls', nav.id);
        controls.append(direct, trigger);
        nav.before(controls);
        nav.setAttribute('data-dsh-mobile-nav', '');
        const close = (focus = false) => {
          nav.removeAttribute('data-open');
          trigger.setAttribute('aria-expanded', 'false');
          if (focus && trigger.isConnected) trigger.focus();
        };
        const buttons = () => [...nav.querySelectorAll('button')].filter(b => !b.disabled);
        const open = () => {
          nav.setAttribute('data-open', '');
          trigger.setAttribute('aria-expanded', 'true');
          buttons()[0]?.focus();
        };
        const onDirect = () => nav.querySelector('button[aria-label="mAgent"]')?.click();
        direct.disabled = !nav.querySelector('button[aria-label="mAgent"]');
        direct.addEventListener('click', onDirect);
        const onTrigger = () => nav.hasAttribute('data-open') ? close(true) : open();
        trigger.addEventListener('click', onTrigger);
        const onKey = event => {
          if (!nav.hasAttribute('data-open')) return;
          // The native More menu owns its own keyboard/focus lifecycle.
          if (nav.querySelector('[aria-haspopup="menu"][aria-expanded="true"]')) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            close(true);
          } else if (nav.contains(event.target) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const rows = buttons();
            const at = rows.indexOf(document.activeElement);
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
              : (at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
            rows[index]?.focus();
          }
        };
        const onOutside = event => {
          if (!nav.contains(event.target) && !controls.contains(event.target)
            && !event.target.closest('[role="menu"]')) close(true);
        };
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('pointerdown', onOutside, true);
        mounted = { nav, dispose() {
          document.removeEventListener('keydown', onKey, true);
          document.removeEventListener('pointerdown', onOutside, true);
          controls.remove();
          nav.removeAttribute('data-dsh-mobile-nav');
          nav.removeAttribute('data-open');
          if (previousId === null) nav.removeAttribute('id'); else nav.id = previousId;
        } };
      };
      const schedule = () => { if (!raf) raf = requestAnimationFrame(sync); };
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ['data-dsh-mobile-open']});
      window.addEventListener('resize', schedule);
      schedule();
      return () => {
        observer.disconnect();
        window.removeEventListener('resize', schedule);
        if (raf) cancelAnimationFrame(raf);
        mounted?.dispose();
      };
    }

    /**
     * Mark the header row that sits under the fixed menu button.
     *
     * Each main-slot view (conversation, mAgent, Plugins, Metrics…) owns its own
     * header, with no shared class. Hit-test the button's footprint and walk up to
     * the widest ancestor that is still a top row (starts near the top and spans
     * most of the column): that row gets INSET, which the stylesheet pads.
     * Phone-only; a no-op while the drawer is open or the button is hidden.
     * @returns the disposer.
     */
    function watchHeaderInset() {
      let raf = 0;
      let marked = null;
      const unmark = () => {
        if (marked) marked.removeAttribute(INSET);
        marked = null;
      };
      const find = () => {
        raf = 0;
        const btn = document.querySelector(`[${MENU}]`);
        const frame = frameEl();
        const center = frame?.querySelector('.' + C.centerCol) || frame?.children[1] || null;
        if (!btn || !center || window.innerWidth > PHONE_MAX) return unmark();
        const b = btn.getBoundingClientRect();
        if (b.width === 0) return unmark();
        const cw = center.getBoundingClientRect().width;
        // The innermost ancestor under the button that spans the column but is not a
        // page-tall scroller: the view's header block, whatever its top padding.
        let row = null;
        for (const el of document.elementsFromPoint(b.left + b.width / 2, b.top + b.height / 2)) {
          if (!center.contains(el) || el === center) continue;
          const r = el.getBoundingClientRect();
          if (r.width >= cw * 0.7 && r.height <= window.innerHeight * 0.4) {
            row = el;
            break;
          }
        }
        // Keep an already-marked row: the padding moved the text out from under the button.
        if (!row && marked && center.contains(marked)) return;
        if (row === marked) return;
        unmark();
        if (row) {
          row.setAttribute(INSET, '');
          marked = row;
        }
      };
      const schedule = () => {
        if (!raf) raf = requestAnimationFrame(find);
      };
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });
      window.addEventListener('resize', schedule);
      schedule();
      return () => {
        if (raf) cancelAnimationFrame(raf);
        observer.disconnect();
        window.removeEventListener('resize', schedule);
        unmark();
      };
    }

    /**
     * The menu button plus the drawer's dismissals.
     *
     * The button renders always; CSS hides it on desktop. The scrim renders only
     * while the drawer is open and closes on tap; Escape closes too, and picking a
     * conversation or a panel closes on the way through, exactly as before.
     */
    function Chrome(props) {
      const toggle = props.toggle;
      const [open, setOpen] = React.useState(drawerOpen);

      React.useEffect(() => {
        const sync = () => setOpen(drawerOpen());
        const observer = new MutationObserver(sync);
        observer.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['data-dsh-mobile-open'] });
        window.addEventListener('resize', sync);
        sync();
        return () => {
          observer.disconnect();
          window.removeEventListener('resize', sync);
        };
      }, []);

      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return;
          if (document.querySelector('[aria-modal="true"]')) return;
          toggle();
        };
        const onTap = (event) => {
          const target = event.target instanceof Element ? event.target : null;
          if (!target) return;
          // Open the stock More menu without collapsing its anchor. Activate a
          // panel/session only after its own click handler has completed.
          const button = target.closest('button');
          if (button?.hasAttribute('aria-haspopup')) return;
          const inDrawer = target.closest('[data-dsh-mobile-drawer]');
          const navigate = inDrawer && (target.closest('[data-row-key^="session:"], .YDXeBa_sessionRow')
            || (button && target.closest('nav')));
          if (navigate || target.closest('.hHd-Xa_moreMenu [role="menuitem"]')) queueMicrotask(toggle);
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('click', onTap, true);
        return () => {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('click', onTap, true);
        };
      }, [open, toggle]);

      return open ? h('div', { className: 'dsh-ml-scrim', 'aria-hidden': 'true', onClick: toggle }) : null;
    }

    const inject = ['slots', 'layout'];

    const BUTTON_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';

    /**
     * The menu button lives on document.body, outside the shell's overlay stacking
     * context, so it stays clickable above the drawer and every view's header.
     * @param toggle - the layout sidebar toggle.
     * @returns the disposer.
     */
    function mountButton(toggle) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute(MENU, '');
      btn.setAttribute('aria-label', 'Menu');
      btn.setAttribute('aria-expanded', 'false');
      btn.title = 'Menu';
      btn.innerHTML = BUTTON_SVG;
      const onClick = () => toggle();
      btn.addEventListener('click', onClick);
      document.body.appendChild(btn);
      return () => {
        btn.removeEventListener('click', onClick);
        btn.remove();
      };
    }

    function apply(ctx) {
      ctx.effect(() => installCss(), 'mobile-layout: stylesheet');
      ctx.effect(() => mountButton(() => ctx.layout.toggleSidebar()), 'mobile-layout: menu button');
      ctx.effect(() => watchDrawer(), 'mobile-layout: drawer markers');
      ctx.effect(() => watchHeaderInset(), 'mobile-layout: header inset');
      ctx.effect(() => mountPanelDisclosure(), 'mobile-layout: labeled panel navigation');
      ctx.effect(
        () =>
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              {
                name: 'shell.overlay',
                id: 'mobile-layout.chrome',
                inject: () => ({
                  toggle: () => ctx.layout.toggleSidebar()
                })
              },
              Chrome
            )
          ),
        'mobile-layout: menu button + scrim'
      );
    }

    return {
      inject,
      apply,
      __internals: { MENU, FRAME, DRAWER, STYLE, PHONE_MAX, DRAWER_MAX, Chrome }
    };
  }
});
