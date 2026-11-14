# @local/dsh-mobile-layout

On a phone the stock shell squeezes a 56px icon rail beside the conversation.
This client plugin removes the rail at phone width (767px and below), adds a
fixed menu button that opens the sidebar as an overlay drawer, and gives the
drawer's panel list touch-sized rows. Tablet and desktop widths are untouched.

## Behavior

- The menu button toggles the shell's own sidebar state; the drawer is the
  stock sidebar column, so every row, menu and shortcut is the native one.
- A tap on the scrim, Escape, choosing a session, or choosing a panel closes the
  drawer. Expanding a workspace folder or opening More keeps it open.
- Focus moves into the drawer when the button opens it and back to the button
  when it closes.
- Layout rules key on markers the plugin writes on the frame it finds
  structurally (the overlay layer's parent). The button only shows once that
  frame is marked, so a DSH update that moves the shell leaves the stock rail in
  place rather than a button over a half-styled layout.

It supersedes `@local/dsh-client-sidebar-mobile`; enable one of the two.

## Tests

```
node --test test/
```

The suite loads `client.js` the way the page's module loader does and checks the
stylesheet's fail-safe and breakpoints and the scrim component.
