window.__ModuleLoader__.load({
  id: '@local/dsh-client-sidebar-mobile',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Phone width: a 280px column leaves the conversation less than the frame's 400px minimum. */
    const PHONE_MAX = 767;
    /** Touch minimum target. */
    const TOUCH = 44;
    /** Widest the drawer gets, whatever the user dragged the desktop column to. */
    const DRAWER_MAX = 320;

    /**
     * Markers this plugin owns. The shell's class names are build-hashed; these are ours.
     *
     * `PHONE` on the root means "the drawer is open": the sidebar is expanded on a phone-width
     * viewport. `DRAWER` marks the column that becomes the drawer, `FRAME` the grid whose first track
     * collapses so the conversation keeps its width behind it.
     */
    const PHONE = 'data-sidebar-mobile';
    const DRAWER = 'data-sidebar-mobile-drawer';
    const FRAME = 'data-sidebar-mobile-frame';
    const CSS = 'data-sidebar-mobile-css';

    /**
     * Whether this viewport needs a drawer rather than the desktop rail.
     * @param width - viewport width in px.
     * @returns true on a phone-width viewport.
     */
    function isPhone(width) {
      return typeof width === 'number' && width > 0 && width <= PHONE_MAX;
    }

    /**
     * The frame element, found structurally rather than by class name.
     *
     * The frame is the element that holds the shell's overlay layer, which it renders unconditionally;
     * the sidebar column is its first child.
     * @returns the frame, or null while the app has not mounted.
     */
    function frameEl() {
      const overlay = document.querySelector('[data-shell-overlay]');
      return overlay ? overlay.parentElement : null;
    }

    /** The sidebar column: the frame's first child. */
    function drawerEl() {
      const frame = frameEl();
      return frame ? frame.firstElementChild : null;
    }

    /** True while the drawer is on screen. */
    function drawerOpen() {
      return document.documentElement.hasAttribute(PHONE);
    }

    /**
     * The stylesheet.
     *
     * While the drawer is open the sidebar leaves the grid flow, so the frame's first track collapses
     * to zero and the conversation keeps the full width behind the drawer; the remaining column
     * children are pinned to their own tracks because auto-placement would otherwise shift them left
     * by one. Everything visible uses theme tokens.
     */
    const STYLE = `
@media (max-width: ${PHONE_MAX}px) {
  /* Keep editable text above Safari's focus-zoom threshold without disabling pinch zoom. */
  input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"] {
    font-size: max(16px, 1em) !important;
  }
  html[${PHONE}] [${FRAME}] {
    grid-template-columns: 0 minmax(0, 1fr) minmax(0, 0px) !important;
  }
  html[${PHONE}] [${FRAME}] > :nth-child(2) { grid-column: 2; }
  html[${PHONE}] [${FRAME}] > :nth-child(3) { grid-column: 3; }
  html[${PHONE}] [${DRAWER}] {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 40;
    width: min(${DRAWER_MAX}px, 84vw);
    box-shadow: 0 8px 40px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent);
    animation: dsh-sm-in 0.18s var(--ds-ease-in-out);
  }
  html[${PHONE}] [${DRAWER}] > div > div {
    width: 100% !important;
    max-width: 100%;
  }
  html[${PHONE}] [${DRAWER}] nav button,
  html[${PHONE}] [${DRAWER}] a,
  html[${PHONE}] [${DRAWER}] button[aria-label="New session"] {
    min-height: ${TOUCH}px;
  }
}
.dsh-sm-scrim {
  position: fixed;
  inset: 0;
  z-index: 39;
  /* The shell's own modal mask, so the drawer dims the page exactly like a dialog does. */
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.24));
  animation: dsh-sm-fade 0.18s var(--ds-ease-in-out);
}
@keyframes dsh-sm-in { from { transform: translateX(-100%); } to { transform: none; } }
@keyframes dsh-sm-fade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  html[${PHONE}] [${DRAWER}], .dsh-sm-scrim { animation: none; }
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

    /** Every marker this plugin may have written, cleared together. */
    function clearMarks() {
      document.documentElement.removeAttribute(PHONE);
      const frame = frameEl();
      if (frame) frame.removeAttribute(FRAME);
      const column = drawerEl();
      if (column) column.removeAttribute(DRAWER);
    }

    /**
     * Keep the markers in step with the frame's own state.
     *
     * The frame reports whether the sidebar is collapsed on its own element, so this watches that
     * attribute instead of measuring anything. It re-reads on resize too: the same frame state means
     * different things at 390px and 1280px.
     * @returns the disposer.
     */
    function watchDrawer() {
      let writing = false;
      const apply = () => {
        if (writing) return;
        const frame = frameEl();
        const column = frame ? frame.firstElementChild : null;
        // The frame omits the attribute while the sidebar is expanded, so absence is the open state.
        const collapsed = Boolean(frame && frame.getAttribute('data-sidebar-collapsed') === 'true');
        const open = Boolean(frame) && !collapsed && isPhone(window.innerWidth) && column !== null;
        writing = true;
        if (open) {
          if (frame.getAttribute(FRAME) === null) frame.setAttribute(FRAME, '');
          if (column.getAttribute(DRAWER) === null) column.setAttribute(DRAWER, '');
          if (!document.documentElement.hasAttribute(PHONE)) document.documentElement.setAttribute(PHONE, '');
        } else {
          clearMarks();
        }
        writing = false;
      };
      let raf = 0;
      // At activation the frame may not be mounted yet, so keep looking until it is; once it exists the
      // observer covers every toggle.
      const boot = () => {
        apply();
        if (frameEl() === null) raf = requestAnimationFrame(boot);
      };
      boot();
      const observer = new MutationObserver(apply);
      observer.observe(document.body, {
        attributes: true,
        subtree: true,
        attributeFilter: ['data-sidebar-collapsed'],
      });
      window.addEventListener('resize', apply);
      return () => {
        writing = true;
        if (raf) cancelAnimationFrame(raf);
        observer.disconnect();
        window.removeEventListener('resize', apply);
        clearMarks();
      };
    }

    /**
     * The scrim, plus the drawer's own dismissals.
     *
     * Nothing renders while the drawer is closed, so a phone with the rail showing pays one null. The
     * scrim is hidden from assistive technology: the drawer's own collapse control is the labelled way
     * out, and this only gives a thumb somewhere to land. Escape and picking a conversation close it
     * too, because on a phone those are the gestures the user already made.
     */
    function ScrimHost(props) {
      const toggle = props.toggleSidebar;
      const [open, setOpen] = React.useState(drawerOpen);
      const panel = props.usePanelInfo((info) => info.activePanelId);
      const lastPanel = React.useRef(panel);

      React.useEffect(() => {
        const root = document.documentElement;
        const sync = () => setOpen(drawerOpen());
        const observer = new MutationObserver(sync);
        observer.observe(root, { attributes: true, attributeFilter: [PHONE] });
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
          // A dialog owns Escape while it is open; the drawer must not close underneath it.
          if (document.querySelector('[aria-modal="true"]')) return;
          toggle();
        };
        const onTap = (event) => {
          const target = event.target instanceof Element ? event.target : null;
          // Opening a conversation is why this drawer is open: dismiss it on the way through.
          if (!target || !target.closest(`[${DRAWER}]`)) return;
          if (!target.closest('[data-row-key^="session:"]')) return;
          toggle();
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('click', onTap, true);
        return () => {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('click', onTap, true);
        };
      }, [open, toggle]);

      // A panel row (Plugins, Automation tasks) leaves the drawer stale: the panel is behind it.
      React.useEffect(() => {
        const changed = panel !== lastPanel.current;
        lastPanel.current = panel;
        if (open && changed) toggle();
      }, [open, panel, toggle]);

      if (!open) return null;
      return h('div', { className: 'dsh-sm-scrim', 'aria-hidden': 'true', onClick: toggle });
    }

    const inject = ['slots', 'layout'];

    function apply(ctx) {
      ctx.effect(() => installCss(), 'sidebar-mobile: stylesheet');
      ctx.effect(() => watchDrawer(), 'sidebar-mobile: drawer markers');
      ctx.effect(
        () =>
          ctx.slots.inject('shell.overlay', () =>
            // One cell beside the shipped overlays: while the drawer is closed it renders null.
            ctx.slots.register(
              {
                name: 'shell.overlay',
                id: 'sidebar-mobile.scrim',
                inject: () => ({ toggleSidebar: () => ctx.layout.toggleSidebar() }),
              },
              ScrimHost,
            ),
          ),
        'sidebar-mobile: scrim',
      );
    }

    return {
      inject,
      apply,
      __internals: { isPhone, frameEl, drawerEl, drawerOpen, STYLE, PHONE_MAX, TOUCH, DRAWER_MAX },
    };
  },
});
