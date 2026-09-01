# Window capture

Window capture is available in the desktop app on macOS, Windows, and Linux with Wayland. It captures a window
from any app and adds the image to the current draft. The attachment includes the app name, window
title, and, when available, the app icon and accessibility data. That data can identify controls,
text, their hierarchy, and their locations in the screenshot. It can include content outside the
visible scroll area when the app exposes it.

Open **Settings** > **Window Capture** to turn it on. Press both Shift keys together to capture a
window on macOS or Windows. Select the shortcut in Settings to record a different
binding: press both keys of another modifier such as Command, Ctrl, or Alt together, or press a key
chord. On Windows and Linux, the Windows or Super key can also open the system's own menu, so prefer
another modifier there. T3 Code checks its own keybindings and, outside Wayland sessions, asks the
operating system whether the shortcut is already reserved before it lets you save.

On Linux with Wayland, choose a key chord; modifier-pair shortcuts are not supported. Saving submits
the shortcut to your desktop's global-shortcut portal. Approve the system prompt if one appears.
T3 Code cannot confirm whether the desktop accepted the binding, so a requested shortcut is not
necessarily active. If your desktop does not support global shortcuts, use **Capture window** from
the command palette.

You can also use **Capture window** from the command palette.

## Platform behavior

- On macOS, T3 Code asks for Accessibility and Screen Recording only when you turn Window Capture
  on and the permission is not already granted. Modifier-pair shortcuts need no additional
  permission on macOS.
- On Windows, the shortcut captures the active window.
- On Linux with Wayland, T3 Code uses your desktop's Screenshot portal when it supports version 3
  and advertises active-window capture. Your desktop may still ask for permission.
- On GNOME, the optional **T3 Code Window Capture** extension enables active-window capture when
  the portal does not support it. The extension supplies the app and window identity, allowing
  T3 Code to attempt an accessibility lookup. Data is included only when the window matches.
  The current extension also brings T3 Code to the foreground after capture and supports the
  capture flash and attachment animation.
- Without either automatic path, the system picker asks you to choose a window or screen.
  Portal captures do not include accessibility data or verified app identity.
- X11 sessions do not support window capture. Apps running through XWayland inside a Wayland
  session can still be captured by the compositor.

Both the shortcut and command-palette action use the same capture path. Cancelling or denying a
capture does not retry through a different backend. Settings shows which Linux backend is available;
shortcut approval is separate from capture permission.

### GNOME extension

Install the **T3 Code Window Capture** extension package for GNOME Shell 45–50, then enable it in
GNOME's Extensions app. A newly installed extension may require signing out and back in before it
appears. Return to **Settings** > **Window Capture** to check that T3 Code detects it.

Enabling this extension grants T3 Code access to the focused window without a per-capture picker.
It captures the rendered window, not an entire scrollable document. It does not work while the
session is locked. Disable the extension in GNOME's Extensions app to revoke this access; T3 Code
will return to the portal or picker path. Remove it there to uninstall it.

Accessibility-data availability depends on the captured app and the operating system. T3 Code still
attaches the image when an app does not expose accessibility data. It waits up to three seconds for
the data; if the app responds too slowly, the screenshot is attached without it. When a complete
element tree is unavailable but text was read in time, T3 Code includes that text as a fallback.

On GNOME, browsers may need desktop app accessibility enabled before they expose text. This is
separate from the speaking screen reader and from screenshot permission. Restart the browser after
enabling app accessibility. Some apps expose only window controls, not the document or terminal
contents; an accessibility indicator does not guarantee that all visible content was included.

A small icon beside the app name on a capture attachment indicates what is included: text lines
mean accessibility data accompanies the screenshot; an image icon means screenshot only. Hover
over the icon or focus it with the keyboard for an explanation. The indicator appears in both the
draft and sent messages.

The shortcut works while another app is active. T3 Code briefly hides itself, captures the selected
window, and then returns with the image attached. If no thread is open, it starts a draft in the
current project.

## Feedback

The settings page controls the capture sound, gentle window cue, and attachment animation
separately. Choose **Off**, **Whoosh** (the default), or **Click** for the capture sound. Use the
play button next to **Whoosh** or **Click** to preview it. With animations on, the captured window
flies into its new composer attachment and settles into place. Turn off animations to remove capture motion.
The operating system's reduced-motion setting also disables the attachment animation.
On Linux, these visual effects require the current T3 Code GNOME extension. GNOME renders them
directly; the portal and picker paths use composer feedback only. After updating an older extension,
sign out and back in to load the new version. Settings tells you when an extension update is needed.

Pending captures stay on disk until the image is saved in the draft. If T3 Code closes during that
step, it retries the capture the next time the desktop app starts. Captures rejected because the
image is too large are deleted and cannot be retried.
