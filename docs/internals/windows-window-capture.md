# Windows window capture

Windows capture runs in the desktop app. The global shortcut and command-palette action use
`DesktopWindowCapture.captureSource`; web and mobile receive the resulting attachment through the
normal thread flow. Provider adapters and remote connection modes do not own the desktop animation.

Source selection is shared desktop policy. Global shortcuts capture the foreground window in place,
including T3 Code, without hiding it. The command-palette action temporarily hides focused T3 to
target the previous app. Both use the same capture backend, persistence, and animation path.
Only the frozen screenshot animates; the real source window is not moved by the feedback.

## Pixels and coordinates

`get-windows` identifies the foreground window in physical screen pixels. T3 converts its bounds
to Electron device-independent coordinates before passing the region to `@crowecawcaw/xa11y`.
xa11y converts that region back to physical pixels using the monitor's DPI. Keep screenshot pixel
dimensions separate from Electron window and animation coordinates, especially with mixed-DPI displays.

The xa11y Windows backend uses a desktop device context, a compatible bitmap,
[`BitBlt`](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-bitblt), and
[`GetDIBits`](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-getdibits).
It reads the visible desktop region rather than requesting an isolated window texture. The native
capture runs on a worker; `Screenshot.toPng()` encodes synchronously.

Icon metadata comes from Electron's matching `DesktopCapturerSource`, with thumbnail dimensions set
to zero so Chromium does not capture the window a second time. Prefer that per-window icon on
Windows because the process executable can be a generic host or carry a different icon. The
executable icon remains the fallback. `get-windows` supplies the application name from executable
version metadata; names that still end in `.exe` have only that suffix removed before display.

`RegionWindowCapture.ts` fits the image within the attachment size limit. When resizing is necessary,
it converts xa11y's copied RGBA pixels to opaque BGRA for `nativeImage.createFromBitmap`, resizes,
then encodes one PNG. Do not first encode the full-size image only to decode it for resizing.
The channel order follows [xa11y's screenshot contract](https://github.com/xa11y/xa11y/blob/v0.13.0/xa11y-js/src/screenshot.rs)
and Electron's native bitmap representation.

## Feedback and handoff

The initial capture handoff awaits `ElectronWindow.reveal`. The shared capture gate covers pixels
and that handoff, then releases while accessibility results and attachment persistence finish
independently for each capture ID. Dispose previous native effects before the next snapshot so they
cannot appear in its pixels. Ready notifications and late failure notifications are passive; they
must not bring T3 forward again. A late failure dismisses only its capture's renderer animation.

On Windows, Electron's `isFocused()` ultimately checks
[`GetActiveWindow`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getactivewindow),
which describes the calling thread's active window, not the system foreground. Chromium can mark
the window active even when Windows denies its `SetForegroundWindow` request; see
[`HWNDMessageHandler::Activate` and `IsActive`](https://github.com/chromium/chromium/blob/152.0.7977.65/ui/views/win/hwnd_message_handler.cc).
Do not use `isFocused()` to skip the native activation fallback.

UI Automation's `IUIAutomationElement::SetFocus` can focus an element without making its top-level
window visible or foreground. It remains a compatibility attempt, not the handoff receipt. After
Electron's normal show/focus calls, Windows reveal attaches T3's UI thread to the current foreground
thread's input queue, calls `SetForegroundWindow` for T3's native HWND, and detaches the queues. The
capture-started event is dispatched only when that call reports success, so a rejected activation
cannot start an animation behind another app. This is the activation operation's native result, not
a later foreground-window query. Verify modifier-pair shortcuts as well as Electron global key
chords: they arrive through different native input paths.

`WindowCaptureTransition.ts` presents the frozen screenshot in transparent, non-activating Electron
windows. Each overlay keeps its native bounds fixed; screenshot movement, scaling, cropping, and
flash happen inside the renderer. Use separate display surfaces to retain each monitor's scale
factor. Display selection must cover the captured region and the route to the destination.

Chromium adds its own show animation to translucent Windows widgets. Its
[Aura visibility controller](https://github.com/chromium/chromium/blob/152.0.7977.65/ui/views/widget/desktop_aura/desktop_native_widget_aura.cc)
animates the content layer's opacity from zero to one and scale from 0.95 to one, using a
[200ms default duration](https://github.com/chromium/chromium/blob/152.0.7977.65/ui/compositor/scoped_layer_animation_settings.cc).
This fades and scales the entire screenshot while the renderer is already animating its flight.
Suppressing that animation was verified to make the initial screenshot appear at full opacity and size.

Overlay showing temporarily appends Chromium's `wm-window-animations-disabled` switch around the
synchronous `showInactive()` calls. It preserves an existing switch and removes only the switch it
added in `finally`. Keep this scope synchronous: [`WindowAnimationsDisabled`](https://github.com/chromium/chromium/blob/152.0.7977.65/ui/wm/core/window_animations.cc)
reads the current command line directly during Aura's visibility callback, and
[Electron's command-line methods](https://github.com/electron/electron/blob/v44.1.0/shell/common/api/electron_api_command_line.cc)
modify that same object. Recheck this internal Chromium behavior when upgrading Electron.

Aura's animation is separate from DWM transitions controlled by
[`DWMWA_TRANSITIONS_FORCEDISABLED`](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute).
Changing that attribute or Electron's `thickFrame` option does not suppress the Aura animation.

Do not resize a visible overlay to start a flight. Electron's `setBounds()` reaches
[`SetWindowPos`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos),
and Chromium invalidates translucent-window backing pixels during resizing. That creates painting
work at the start of the animation. Electron also documents
[transparent-window resize limitations](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles#limitations).

The screenshot is decoded before showing the overlay. On Windows, showing all overlay surfaces is
followed by a one-pixel `webContents.capturePage()` readback before restoring or foregrounding T3.
Otherwise, T3 can become visible while the screenshot surface is still transparent, then disappear
behind the screenshot as its first frame arrives. Restoring T3 after a command-palette capture also
waits for this initial overlay preparation; shortcut self-capture leaves T3 visible throughout.

Flight animations are prepared and paused at time zero. Two animation-frame callbacks submit the
layout and paint work, but do not wait for the GPU to finish. A second readback on Windows waits for
Chromium's compositor output before starting the animation clocks. This prevents cold raster and
shader work from consuming the beginning of the flight. These are Chromium output receipts, not
guarantees that DWM has presented a frame. All display surfaces finish preparation before playback.
Landing waits for the animations to finish, then for the destination attachment to paint before the
overlay is dismissed.

The animated flash shares the screenshot renderer. Avoid a second native window whose opacity is
updated on a main-process timer: Electron maps `setOpacity()` to
[`SetLayeredWindowAttributes`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setlayeredwindowattributes).
The small standalone flash remains the fallback when the screenshot transition is unavailable or
animations are disabled.

Transparent Electron windows are not necessarily software-rendered. Chromium normally uses
premultiplied DirectComposition surfaces and
[`DwmExtendFrameIntoClientArea`](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/nf-dwmapi-dwmextendframeintoclientarea);
see its [window configuration](https://github.com/chromium/chromium/blob/152.0.7977.65/ui/views/widget/widget_hwnd_utils.cc).
Diagnosing software fallback or skipped presentation frames requires runtime evidence.

Changes to this path need focused checks for capture ordering, reduced motion, cancellation, and
attachment handoff. Visual verification should include source windows crossing display boundaries,
mixed-DPI monitors, and a destination on another display. Measure capture latency separately from
animation frame delivery; reducing PNG work alone does not establish smoother animation.
