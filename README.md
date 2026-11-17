# StreamFlow

A userscript for HTML5 video and audio on any website. It adds keyboard speed control, Picture-in-Picture, timestamp and screenshot tools for taking notes, and keeps videos playing while you work in another window.

**Version 3.0**

## Features

- **Speed control on any site.** Use `[` and `]` to change speed and `\` to reset it. An on-screen HUD shows the new speed and how much time is left at that speed.
- **Remembers your speed per site.** The speed you set is applied again when the next video loads, even on sites that reset it.
- **Quick toggle and boost.** Switch between 1x and your last speed, or hold a key to play faster for a moment.
- **Picture-in-Picture** with one shortcut, including on sites that don't show a PiP button.
- **Note-taking tools:**
  - Copy the current timestamp (`12:34`)
  - Copy a Markdown link that opens the video at that time (`[12:34](https://...)`)
  - Copy the current frame to the clipboard as an image, or save it as a PNG
  - Jump back to replay a few seconds, or skip forward
  - A-B loop a section
  - Step forward or back one frame
- **Background keep-alive.** Stops pages from pausing or lowering quality when you switch to another window, such as a notes app next to the video.
- **Copy and right-click unlock.** Stops sites from blocking right-click or text selection, or from adding tracking text to what you copy.
- **Telemetry blocker.** Blocks common analytics and tracking requests sent while you watch.
- **Every shortcut can be changed**, and settings sync across your open tabs.
- Finds players inside shadow DOM and keeps the HUD visible in fullscreen.

## Installation

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open the script's raw file, and your userscript manager will offer to install it:
   **[Install StreamFlow](https://raw.githubusercontent.com/XDefoeRedstoneX/Streamflow/main/streamflow.user.js)**
3. Reload any open video pages.

To install it by hand, create a new script in your userscript manager and paste in the contents of [`streamflow.user.js`](streamflow.user.js).

## Keyboard shortcuts

| Action | Default shortcut |
| --- | --- |
| Slower (−0.25x) | `[` |
| Faster (+0.25x) | `]` |
| Reset to 1.00x | `\` |
| Toggle between 1x and your last speed | `Alt` + `R` |
| Boost while held (2x) | Hold `` ` `` |
| Picture-in-Picture | `Alt` + `P` |
| Copy timestamp | `Alt` + `C` |
| Copy timestamped Markdown link | `Alt` + `L` |
| Screenshot current frame | `Alt` + `G` |
| Replay (jump back 5s) | `Alt` + `Z` |
| Skip forward 10s | `Alt` + `X` |
| A-B loop (start, end, clear) | `Alt` + `A` |
| Previous frame | `Alt` + `,` |
| Next frame | `Alt` + `.` |
| Open settings | `Alt` + `/` |

- On a Mac, `Alt` is the `Option` key.
- `[`, `]` and `\` work on any keyboard layout, including layouts where you type them with AltGr or Option.
- Shortcuts don't fire while you're typing in a text box or search field.
- If the video is in an embedded player (an iframe), click the player once so it receives your key presses.
- When a page has more than one video, StreamFlow controls the one that is playing. If none is playing, it uses the largest one on screen or the one you played last.

## Settings

Open settings with `Alt` + `/`, or choose **StreamFlow Settings** from your userscript manager's menu. Changes save immediately and apply on every site.

**Changing a shortcut:** click the shortcut's button, then press the new key or key combination. Press `Esc` to cancel or `Backspace` to remove the shortcut. If another action already uses that shortcut, that action is left without one.

| Option | Default | Range |
| --- | --- | --- |
| Speed step | 0.25x | 0.05–2 |
| Boost speed | 2x | 0.25–16 |
| Replay jump | 5 seconds | 1–600 |
| Skip jump | 10 seconds | 1–600 |
| Frame rate for frame step | 30 fps | 1–240 |
| Remember speed per site | On | |
| Show time remaining in the HUD | On | |
| Also save screenshots as PNG files | Off | |

The **This site** section lets you turn StreamFlow on or off for the current site and clear the speed saved for it. **Restore defaults** resets all options and shortcuts.

### Userscript manager menu

- **StreamFlow Settings:** opens the settings panel.
- **Disable / Enable StreamFlow on `<site>`:** turns the shortcuts and HUD off or on for the current site.
- **Test HUD Notification:** shows a sample HUD message to check that the script is running.

## How it works

### Speed

- Speed is saved for each website (by hostname). Resetting to 1.00x removes the saved speed for that site.
- When a new video loads and the site resets the speed within the first few seconds, StreamFlow sets your speed again. Changes you make later with the site's own speed menu are left alone.
- Saved speeds are not applied to live streams, because speeding up a live stream only makes it stall, or to audio clips shorter than 10 seconds, such as sound effects.
- With the default step, the speed keys go from 0.25x up to 16x, which is the browser's limit.
- The toggle shortcut switches between 1x and the last speed other than 1x you used, or 1.5x if you haven't set one yet.

### Timestamp links

`Alt` + `L` copies a Markdown link that opens the video at the current time:

| Site | Link format |
| --- | --- |
| YouTube (including embeds, Shorts and YouTube Music) | `https://www.youtube.com/watch?v=ID&t=754s` |
| Vimeo | `https://vimeo.com/ID#t=12m34s` |
| Twitch VODs | `https://www.twitch.tv/videos/ID?t=0h12m34s` |
| Any other site | The page URL with `#t=754` added |

### Screenshots

`Alt` + `G` copies the current frame to the clipboard as a PNG. If the browser doesn't allow that, or if **Also save screenshots as PNG files** is on, the frame is downloaded as a file named after the page title and the timestamp.

Videos protected with DRM (for example Netflix or Disney+) and some videos loaded from another domain can't be captured. The HUD tells you when this happens.

### Frame step

Frame step pauses the video and moves one frame at the frame rate set in settings (30 fps by default). Set it to the video's actual frame rate to move exactly one frame at a time.

## Known limitations

These parts of StreamFlow run on **every page**, and turning StreamFlow off for a site does not stop them.
If a site breaks, exclude it from StreamFlow in your userscript manager's settings for the script (in Tampermonkey: the script's **Settings** tab, **User excludes**).
The HUD can't appear when the `<video>` element itself is fullscreen. Most sites make their whole player fullscreen, and the HUD works there.
Picture-in-Picture doesn't work on sites that turn it off, or in browsers that don't let scripts start it. The HUD tells you when this happens.

## Privacy

StreamFlow does not send any data anywhere. Your settings and saved speeds are stored by your userscript manager, or in the site's `localStorage` if the manager doesn't provide storage.
