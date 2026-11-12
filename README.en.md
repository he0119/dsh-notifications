# dsh-notifications: conversation alerts for DSH

English | [中文](README.md)

Adds one thing to DeepSeek Harness (DSH): an alert when a conversation finishes, stops with an error, asks you a question, or waits for your approval. It works while the DSH window is in the background or you are on another browser tab.

Requires DSH **^0.2.0-rc.1**, which covers every 0.2.x release and prerelease. Development and tests run against **0.2.2-rc.2**.

## Install

1. Open the DSH plugin manager and choose Add plugin.
2. Enter the package name `@he0119/dsh-notifications`, install, and restart when asked.
3. Open **Plugins** in the sidebar, pick the notification plugin, and adjust the options in its card.

For local development you can install the checkout directory, or run `pnpm run pack:release` and install the tarball from `artifacts/`.

## What it can alert you about

Four events, each with its own switch and sound:

| Event | When it fires |
| --- | --- |
| Completed | The assistant finished this turn normally |
| Interrupted | It stopped because of an error or a limit |
| Reply needed | The assistant is waiting for your answer |
| Approval needed | A tool call is waiting for your approval |

Only root conversations are announced, including the ones you forked yourself. Subagents and teammates never ring or pop up, so one task cannot flood you with notifications.

## How it alerts

- **System popups**: never, when unfocused, or always. "When unfocused" covers a background DSH window and a browser on another tab.
- **Sounds**: an independent switch and volume, separate from popups. Enabled event sounds play in the foreground and the background.
- **Custom audio**: import your own audio for each event, or keep the built-in tones. Custom audio stays on this device, up to 5 MiB per file, and only the first 8 seconds are played. Replace or remove it at any time.
- Click a notification to return to its conversation. On Windows desktop, DSH uses a native protocol notification to restore the main window.

## Requirements and limitations

- System popups need either the Windows desktop app, or a desktop browser (or Android Chrome/Edge) on an HTTPS page. A local `localhost` page also counts as a secure context.
- The browser must be allowed to show notifications the first time; the audio autoplay policy may block the first sound until you use Preview once.
- A remote phone browser must still be running and connected. A suspended background tab, a locked screen or a closed browser will miss alerts; this plugin does not push offline.
- The first Windows notification installs a click handler for the current user (under `%LOCALAPPDATA%\DshNotifications`, plus a `dsh-notifications` protocol). It needs no administrator rights and does not touch DSH's own protocol, shortcuts or icon.
- Identifiers are independent from the notification component inside Cyaness Tools: its own plugin row, Remote namespace, worker path and protocol. Enabling both at once rings and pops twice, so enable only the one you use.

## Working on the plugin

See [docs/development.md](docs/development.md).

## Acknowledgements

This package is the notification component of [Cyaness Tools](https://git.hehome.xyz/hcy0317/dsh-Cyaness-tool),
split out into a standalone package: the host event source, the delivery chain and the Windows native
notification all come from that project. Only the packaging is new, so people who do not want the rest of
the bundle still get the alerts.

## License

MIT, see [LICENSE](LICENSE).
