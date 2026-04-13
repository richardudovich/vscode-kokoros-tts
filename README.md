# Kokoros TTS Preview

Speak selected markdown or text from VS Code using a local [Kokoros](https://github.com/lucasjinreal/Kokoros) server.

This extension is built for a fast local workflow:

- select part of a markdown file or a full document
- right-click and choose `Speak with Kokoros`
- hear the result in a side playback panel
- optionally highlight the text as the audio plays

The extension talks to Kokoros through its local OpenAI-compatible HTTP server.

## Features

- Right-click command for editor selections
- Command to speak the full active document
- Auto-start, stop, and restart commands for the local Kokoros server
- Configurable worker instance count, voice, port, speech speed, and markdown cleanup
- Streaming mode for better latency and better long-text throughput
- Estimated playback highlighting for markdown or prose selections

## Requirements

- macOS, Linux, or another environment where [Kokoros](https://github.com/lucasjinreal/Kokoros) can run
- Node.js for extension development and packaging
- A built `koko` binary plus Kokoro model and voice data

On macOS, Kokoros needs:

```bash
brew install pkg-config opus cmake
```

## Quick setup

### Option 1: use the included bootstrap helper on macOS

```bash
cd /path/to/vscode-kokoros-tts
bash scripts/bootstrap-kokoros-macos.sh
```

By default that installs Kokoros into `~/.local/share/Kokoros` and builds:

```text
~/.local/share/Kokoros/target/release/koko
```

### Option 2: point the extension at an existing Kokoros checkout

If you already built Kokoros somewhere else, set:

- `kokorosTts.kokorosExecutable`
- `kokorosTts.kokorosWorkingDirectory`

The current machine used during development also works with:

```text
/tmp/Kokoros/target/release/koko
```

## Extension settings

Open Settings and search for `Kokoros TTS`.

Important settings:

- `kokorosTts.kokorosExecutable`
- `kokorosTts.kokorosWorkingDirectory`
- `kokorosTts.port`
- `kokorosTts.instances`
- `kokorosTts.voice`
- `kokorosTts.speed`
- `kokorosTts.streamAudio`
- `kokorosTts.stripMarkdown`
- `kokorosTts.highlightMode`

Recommended starting values:

- `instances = 4` for longer markdown documents on Apple Silicon
- `streamAudio = true`
- `stripMarkdown = true`
- `highlightMode = estimated`

## Usage

### Speak a selection

1. Open a markdown or text document.
2. Select the section you want.
3. Right-click.
4. Choose `Speak with Kokoros`.

### Speak the active document

Run:

```text
Kokoros TTS: Speak Active Document with Kokoros
```

from the Command Palette.

### Manage the local server

Use the Command Palette:

- `Kokoros TTS: Start Server`
- `Kokoros TTS: Stop Server`
- `Kokoros TTS: Restart Server`
- `Kokoros TTS: Check Kokoros Setup`

## Development

Install dependencies:

```bash
cd /path/to/vscode-kokoros-tts
npm install
```

Compile:

```bash
npm run compile
```

Run the extension in VS Code:

1. Open the `vscode-kokoros-tts` folder in VS Code
2. Press `F5`
3. In the Extension Development Host, test the `Kokoros TTS` commands

Package a VSIX:

```bash
npm run package
```

## Notes on highlighting

The current highlight mode is `estimated`, not word-perfect.

It splits the selected text into sentence or paragraph chunks and maps those chunks onto the final audio duration. That makes it useful for following along while staying lightweight and fast.

Future improvement path:

- switch to a timestamp-capable Kokoro model
- use exact token or word timings for highlight updates
