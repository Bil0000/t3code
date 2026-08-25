# Window capture

Window capture is available in the desktop app on macOS, Windows, and Linux. It captures a window
from any app and adds the image to the current draft. The attachment includes the app name, window
title, app icon, and available accessibility text. That text can include content outside the visible
scroll area when the app exposes it.

Open **Settings** > **Window Capture** to turn it on. Press both Shift keys together to capture a
window on macOS, Windows, and Linux with X11. On Linux with Wayland, T3 Code uses Ctrl+Shift+2
because Wayland does not expose physical modifier pairs. Select the shortcut in Settings to record
a different binding: press both keys of another modifier such as Command, Ctrl, or
Alt together, or press a key chord. On Windows and Linux, the Windows or
Super key can also open the system's own menu, so prefer another modifier there. On macOS, Windows, and Linux with X11, T3 Code checks its own
keybindings and asks the operating system whether the shortcut is already reserved before it lets
you save. On Wayland, the system confirms the shortcut when you turn Window Capture on.

You can also use **Capture window** from the command palette or the **Capture now** button on the
settings page.

## Platform behavior

- On macOS, T3 Code asks for Accessibility and Screen Recording only when you turn Window Capture
  on and the permission is not already granted. Modifier-pair shortcuts need no additional
  permission on macOS.
- On Windows and Linux with X11, the shortcut captures the active window.
- On Linux with Wayland, the system portal asks you to choose the window or screen to share. Portal
  captures attach the image without accessibility text because the portal does not identify the
  selected window.

Text availability depends on the captured app and the operating system. T3 Code still attaches the
image when an app does not expose accessibility text.

The shortcut works while another app is active. T3 Code briefly hides itself, captures the selected
window, and then returns with the image attached. If no thread is open, it starts a draft in the
current project.

## Feedback

The settings page controls the capture sound, gentle window cue, and attachment animation
separately. Use **Test sound** to hear the capture sound. Turn off animations to remove capture
motion. The operating system's reduced-motion setting also disables the attachment animation.

Pending captures stay on disk until the image is saved in the draft. If T3 Code closes during that
step, it retries the capture the next time the desktop app starts.
