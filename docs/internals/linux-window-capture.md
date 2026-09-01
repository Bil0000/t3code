# Linux window capture

Linux window capture supports Wayland sessions only. This does not remove X11 support from the
Electron app itself. Windows still uses the region-capture and native modifier-hook adapters;
macOS retains its native capture path.

`apps/desktop/src/windowCapture/LinuxWindowCapture.ts` selects a backend for each capture:

1. Screenshot portal interface version >= 3 **and** `AvailableTargets & 8`: request `target=8`
   (active window), `interactive=false`. Version alone is insufficient. This does not bypass consent.
2. GNOME extension protocol version 1 or 2: capture the focused window actor without a picker.
3. Neither available: the existing Electron/PipeWire picker.

Failures, cancellation, timeouts, and permission denial do not select a different backend. All
entry points go through `DesktopWindowCapture.captureSource`. The optional `linuxBackend` IPC
state distinguishes this choice from `mode=portal`, which continues to control Wayland shortcut
registration. The global-shortcut portal and screenshot permission are independent.

The standard API returns a PNG URI only, not a stable window identity. Do not infer accessibility
context from the subsequently focused window or a guessed title. Extension metadata contains the
captured window's PID, title, frame bounds, and desktop app ID. The existing bounded accessibility
reader attempts an AT-SPI element-tree lookup by PID and requires a unique title/size match on
Wayland. Element bounds are converted from the matched AT-SPI window into captured-image pixels.
Wayland locations are trusted only when the AT-SPI root position agrees with the compositor's
captured frame and at least one descendant reports a distinct position. Otherwise the known root
covers the image and descendant bounds are `null` rather than misleading zero-origin rectangles.
Anonymous empty groups are removed and anonymous single-child group chains are collapsed before
applying the payload limit. The legacy flattened text is retained for mixed-version clients, while
new provider prompts prefer the structured tree.
Title matching ignores a single leading Braille CLI spinner followed by whitespace, since terminal
apps can change its frame between capture and lookup. The remaining title must be nonempty and match
exactly. This normalization also applies when checking ambiguity; an exact spinner frame does not
take precedence over another window with the same normalized title and size.
AT-SPI can report `(0, 0)` for a window's screen position even when the compositor knows its real
position, so only width and height are compared (within two logical pixels). Ambiguous matches
are rejected; macOS and Windows continue to require matching position as well as size. Sandboxed
apps, scaling differences, and incomplete accessibility providers can make that lookup fail; the image
still succeeds. Electron does not position window overlays on Wayland; extension v2 uses Shell actors.

Accessibility reads return as soon as they finish, with a shared three-second deadline on all
desktop platforms. This accommodates larger browser trees without adding a fixed delay to fast
reads. On timeout, capture uses completed flat text or a partial bounded tree when available, then
continues without accessibility data otherwise; no further accessibility read starts until the
outstanding native read settles.

On GNOME, browser accessibility bridges may require `org.gnome.desktop.interface toolkit-accessibility`
to be enabled before the browser starts. This is separate from `screen-reader-enabled` and screenshot
permission. Do not change the desktop setting implicitly during capture. Even with the bridge enabled,
apps may expose only window controls rather than their main content; Ghostty 1.3.1's GTK terminal surface
does not implement the accessible-text interface.

## D-Bus lifetime

Each discovery/capture owns a short-lived session-bus connection. Unsandboxed clients register
their desktop app ID with `org.freedesktop.host.portal.Registry` before accessing portal APIs.
The connection owns the request until the response or timeout. The signal match is installed
before `Screenshot`, and responses arriving before the method reply are retained. Signals must
come from the portal's unique owner and this connection's request namespace. Failed pending
requests are closed; disconnecting removes matches and temporary names.

PNG reads accept local file URIs only and are bounded to 32 MiB. Portal-owned files are not removed.
Images are fitted within 2560×1600 while preserving aspect ratio. D-Bus uses `dbus-next` without
its optional native Unix-FD dependency; no capture path transfers file descriptors.

## GNOME extension

Source: `apps/desktop/gnome-extension`. UUID: `window-capture@t3.codes`.

The extension exports `org.gnome.Shell.Extensions.T3WindowCapture` at
`/org/gnome/Shell/Extensions/T3WindowCapture`. `Version` is a read-only uint32. `Capture()` returns
`(ay png, s metadataJson)`. PNG data stays in memory; no caller-supplied file paths or window IDs
are accepted. `Shell.Screenshot.screenshot_window` snapshots the focused actor synchronously before
asynchronously encoding it. Metadata is read immediately before that call, without yielding.

The caller must own `com.t3tools.T3Code.WindowCapture` or
`com.t3tools.T3Code.Development.WindowCapture` on the same connection. Names are acquired without
replacement or queueing and checked on each call. This follows GNOME's trusted-session-client
pattern, not authentication against malicious processes with full access to the user's session
bus. Installing/enabling the extension is an explicit trust decision. It refuses locked, greeter,
and non-Wayland sessions; disabling it also prevents in-flight captures from returning pixels.
Only one capture can run at a time. No `unsafe_mode`, Shell evaluation, or global key hooks are used.

Protocol v2 preserves `Capture()` and adds `CaptureWithFeedback(b flash, b animate) -> (ay, s, b)`.
The final boolean says whether Shell created an animation actor. The caller retains the same bus
connection for `Activate(s title)` and `Animate(d x, d y, d width, d height)`. Activation happens
only after capture, once Electron has restored its window. The bus daemon supplies the caller's
PID; only a normal window of that process can be activated. Title disambiguates multiple windows;
ambiguous matches are rejected. A temporarily hidden window is awaited through Shell's map signal.

Animation coordinates are relative to T3's content area (0–1), including renderer zoom. GNOME
maps them onto the target window's current compositor bounds, avoiding Electron's unavailable
Wayland screen origin. The preview is frozen actor content, not a live clone. Finite Clutter
transitions handle the flash and flight without per-frame JavaScript or polling. Both Electron's
and Shell's reduced-motion preferences are respected. `Animate` replies after landing, and the
desktop waits for that flight before acknowledging/deleting the capture. Disconnecting, disabling,
locking, a monitor change, or a six-second deadline removes Shell actors. The desktop connection
also has a 15-second lifetime bound. Optional focus/effect failures do not discard a captured PNG.

`linuxFeedbackAvailable` is true only for protocol v2. A v1 extension can still capture, but settings
asks for an extension update before offering effects. macOS/Windows keep the existing transition;
the standard portal and picker do not gain GNOME-only focus/overlay capabilities.

The extension targets GNOME Shell 45–50's ES module API. GNOME Shell internals are not stable across
major versions: review the capture API and verify each future version before adding it to metadata.
GNOME 50 removed the X11 compositor and `Meta.is_wayland_compositor`; the compatibility check calls
that function only on older versions where it exists.

### Package and install for testing

```bash
vp run dist:gnome-extension
gnome-extensions install --force release/window-capture@t3.codes.shell-extension.zip
```

Sign out and back in if this is the first install, then:

```bash
gnome-extensions enable window-capture@t3.codes
```

Wayland does not support restarting Shell with Alt+F2 → `r`. Do not restart someone's live session
to test an extension. After changing extension source, repack/reinstall and sign out/in to ensure
the new module is loaded. Reopening/focusing T3's capture settings refreshes capability discovery.

To revoke/uninstall:

```bash
gnome-extensions disable window-capture@t3.codes
gnome-extensions uninstall window-capture@t3.codes
```

### Verification

```bash
vp test run apps/desktop/src/windowCapture/LinuxWindowCapture.test.ts apps/desktop/src/windowCapture/LinuxWindowCapture.dbus.test.ts apps/desktop/src/windowCapture/DesktopWindowCapture.test.ts apps/desktop/gnome-extension/captureService.test.js apps/web/src/components/settings/WindowCaptureSettings.logic.test.ts
```

The D-Bus test uses its own daemon/socket in a temporary directory, not the desktop session bus.
It runs when `dbus-daemon` is available. Unit tests cover capability selection, early responses,
timeouts, cancellation, fallback boundaries, image validation, extension authorization/lifecycle,
X11 rejection, and backend-specific status text. They do not prove a live GNOME Shell capture.

For a live pass, explicitly enable the extension and approve T3's shortcut. Capture a known native
Wayland app and an XWayland app using both the shortcut and command palette. Check the PNG, window
identity, and optional text; test mixed-DPI displays. Disable the extension and confirm fallback.
Test a v3-capable portal separately: this host's GNOME Screenshot v2 cannot validate that backend.

Protocol references: [Screenshot portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Screenshot.html),
[Request lifecycle](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Request.html),
[host Registry](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.host.portal.Registry.html),
[GNOME screenshot implementation](https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/src/shell-screenshot.c).
