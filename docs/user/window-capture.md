# Window capture

Window capture is available in the desktop app on macOS, Windows, and Linux. It captures a window
from any app and adds the image to the current draft. The attachment includes the app name, window
title, app icon, and available accessibility text. That text can include content outside the visible
scroll area when the app exposes it.

Open **Settings** → **Window Capture** to turn it on. The default global shortcut is
`mod+shift+2`: Command+Shift+2 on macOS and Ctrl+Shift+2 on Windows and Linux. Select the shortcut
in Settings to record a different one. T3 Code reports when another app already uses it.

You can also use **Capture window** from the command palette or the **Capture now** button on the
settings page.

## Platform behavior

- On macOS, allow Accessibility and Screen Recording when the system asks.
- On Windows and Linux with X11, the shortcut captures the active window.
- On Linux with Wayland, the system portal asks you to choose the window or screen to share.

Text availability depends on the captured app and the operating system. T3 Code still attaches the
image when an app does not expose accessibility text.

The shortcut works while another app is active. T3 Code briefly hides itself, captures the selected
window, and then returns with the image attached. If no thread is open, it starts a draft in the
current project.

## Feedback

The settings page controls the capture sound, window flash, and attachment animation separately.
Turn off animations to remove capture motion. The operating system's reduced-motion setting also
disables the attachment animation.

Pending captures stay on disk until the image is saved in the draft. If T3 Code closes during that
step, it retries the capture the next time the desktop app starts.
