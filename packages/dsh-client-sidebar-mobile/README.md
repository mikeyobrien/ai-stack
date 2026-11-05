# Mobile Sidebar

The left sidebar on a phone: opening it slides a drawer over the conversation instead of squeezing the
conversation into the leftover 110px. Nothing changes at or above 768px.

## What a phone gets

- **The expanded column becomes an overlay drawer.** Below 1024px the shell collapses the sidebar to its
  56px rail; expanding it normally hands 280px to the column and leaves the conversation a sliver. The
  plugin takes the expanded column out of the grid, collapses the frame's first track to zero, and floats
  the column as a `min(320px, 84vw)` drawer over a full-width conversation.
- **A scrim closes it.** A full-viewport cell behind the drawer dismisses it on tap and uses the shell's
  own modal mask token, so the page dims exactly as it does behind a dialog. The scrim is hidden from
  assistive technology: the drawer's own collapse control is the labelled exit.
- **Escape closes it**, unless a modal dialog is open — that dialog owns the key.
- **Picking a conversation closes it**, and so does picking a panel row (Plugins, Automation tasks),
  because both land behind the drawer.
- **No focus zoom.** Editable fields, including the chat composer, use at least 16px text on phones;
  pinch-to-zoom remains available, and larger inherited font sizes are preserved.
- **Touch targets.** Navigation rows, links, and New Session are at least 44px tall inside the drawer.

## Where it attaches

The sidebar's class names are build-hashed, so the plugin keys off attributes it owns plus two shell
markers: the overlay layer (`[data-shell-overlay]`, which locates the frame) and the frame's
`data-sidebar-collapsed` flag.

| Hook | Owner | Use |
|---|---|---|
| `data-sidebar-collapsed` on the frame | `ui-layout` | Says whether the sidebar is expanded |
| `[data-shell-overlay]` | `ui-layout` | Locates the frame; its first child is the column |
| `data-row-key="session:…"` | `ui-workspace` | A conversation row, which dismisses the drawer |
| `data-sidebar-mobile` on `<html>` | this plugin | The drawer is open; scopes the stylesheet |
| `data-sidebar-mobile-frame` on the frame | this plugin | The grid whose first track collapses |
| `data-sidebar-mobile-drawer` on the column | this plugin | The drawer itself |
| `shell.overlay` id `sidebar-mobile.scrim` | this plugin | The scrim cell, beside the shipped overlays |

The scrim is a separate overlay cell, not a replacement: the shipped overlays keep their registrations
and order. One `<style>` element is added, and disposal removes the markers, the stylesheet, the
observer, and the resize listener.

## Limits

- The grid tracks are pinned by child position (`:nth-child`), because the column leaves the flow and
  auto-placement would shift the conversation and right panel left by one. A frame that reorders its
  column children would need this updated; without the marker the layout is untouched.
- The drawer holds no focus trap: Tab can leave it. Escape, the scrim, the drawer's own collapse control,
  and picking a conversation are the four exits.
- Between 768px and 1024px the shipped rail and the shipped squeeze apply unchanged.

## Layout

| File | Purpose |
|---|---|
| `client.js` | Browser module: markers, stylesheet, scrim cell, dismissals |
| `index.js` | Host half, empty: the whole feature is browser-side |
| `cordis.patch.yml` | Inserts the plugin row |
| `locale/en.json` | Bundle display metadata |
| `icon.svg` | Artwork for the plugin manager |
| `test/client.test.mjs` | Behaviour tests over a stub DOM |

Run the tests with `node --test test/`.
