# AI Medical Scribe

![Demo](demo.gif)

AI Medical Scribe is a browser-based prototype for live consultation transcription, on-device summarisation, document drafting, and client-side FHIR export.

It is designed as a local-first front end. Session capture, notes, summaries, generated documents, FHIR exports, settings, and customisation are all handled in the browser with no project backend.

## Why

Most AI medical scribes rely on cloud processing and external APIs.

This project explores a different approach:
- no backend
- no API keys
- no data leaving the device

## Features

- Live consultation transcription using Chrome's speech recognition support.
- Manual note capture alongside the live transcript.
- Important-moment markers inside the transcript timeline.
- On-device AI summary generation after transcription stops.
- Rich text document drafting from transcript content using configurable templates.
- Client-side FHIR R4 Bundle export for the active session or a selected history session.
- Session history with review, edit, duplicate, archive, and delete workflows.
- Optional encrypted session storage at rest using the browser Web Crypto API.
- App-level lock and unlock controls with inactivity auto-lock for sensitive session content.
- Explicit privacy controls for retention, purge-on-close, ephemeral consultations, and destructive local deletion.
- Local customisation for organisation name, colour, snippets, tags, and document templates.
- Local persistence through browser storage.

## Requirements

This prototype currently depends on Chrome features that are still rolling out unevenly.

### Browser

- A recent Chrome build is required.
- For local web-page prototyping, Chrome Canary or a recent Chrome build with the relevant built-in AI flags enabled is usually the most reliable setup.
- The app should be served on `localhost` for Prompt API prototyping.

### Platform

Current Chrome documentation for Gemini Nano-based built-in AI features points to these general requirements:

- Windows 10 or 11, macOS 13+, Linux, or ChromeOS on Chromebook Plus devices.
- At least 22 GB free space on the volume containing the Chrome profile.
- Either a GPU with more than 4 GB VRAM, or a CPU-based system with at least 16 GB RAM and 4 CPU cores.
- An unmetered network connection for the initial model download.

These built-in AI APIs do not currently work on mobile browsers.


## Setup

You can run the app in two ways:

#### Option A: Open directly (simplest)

Open the HTML file directly in Chrome, simply download the zip file, extract and open ai_medical_scribe.html

```text
file:///path/to/ai_medical_scribe.html
```

This is the quickest way to get started and works for most features in this prototype.

#### Option B: Serve via localhost (recommended for Prompt API prototyping)

Run a local static file server from the project folder. For example:

```bash
python -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

Some Chrome built-in AI features are documented for use on `localhost`, so this setup may be more reliable across different Chrome versions.

Opening via `file://` works in current Chrome builds, but future versions may require `localhost` for some built-in AI features.

If you encounter issues with AI features not being available, try switching to the `localhost` setup.

### 2. Enable Chrome built-in AI flags

Open:

```text
chrome://flags
```

Enable:

```text
chrome://flags/#optimization-guide-on-device-model
```

Then enable whichever Prompt API flag exists in your Chrome build, for example:

```text
chrome://flags/#prompt-api-for-gemini-nano
```

or:

```text
chrome://flags/#prompt-api-for-gemini-nano-multimodal-input
```

After changing flags, relaunch Chrome.

### 3. Let Chrome download the on-device model

The first use of Prompt API features may trigger a model download for the current origin.

You can check model status in DevTools:

```js
await LanguageModel.availability({
  expectedOutputLanguage: 'en',
  expectedOutputs: [{ type: 'text', languages: ['en'] }]
});
```

Typical responses include:

- `unavailable`
- `downloadable`
- `downloading`
- `available`

### 4. Inspect model diagnostics if needed

Useful Chrome diagnostics pages:

```text
chrome://on-device-internals
```

```text
chrome://components
```

In some Chrome builds, `chrome://components` may show `Optimization Guide On Device Model`, which can be a useful sanity check.

## Quick Demo

1. Open `ai_medical_scribe.html` in Chrome
2. Click "Start session"
3. Speak or simulate a consultation
4. Stop session to generate summary

## How It Works

### Transcription

Live transcription uses `webkitSpeechRecognition` when it is available in the browser.

### Summaries

Consultation summaries are generated on-device using Chrome's Prompt API when available, with Summarizer API fallback support in this prototype.

### Documents

Document drafts are generated from the transcript using Chrome's on-device model path and stored as editable rich text HTML.

### FHIR Export

Sessions can be exported as a FHIR R4 JSON Bundle directly in the browser.

What that means in practice:

- The app can package a consultation into a structured healthcare data document rather than only plain text or HTML.
- The export is built on demand from the current in-browser session object and downloaded as a `.json` file.
- No backend is used and the generated FHIR is not stored separately in local storage.
- The Bundle is document-style and includes a `Composition` as the first entry, plus the related `Encounter`, `Organization`, optional `Patient` and `Practitioner`, and `DocumentReference` resources for transcript, manual notes, and generated documents.
- Clinical summary content is currently exported as narrative XHTML sections rather than deeply coded clinical resources. That makes it useful for interoperability experiments, testing, and downstream mapping, but it is still a prototype export rather than a production clinical integration.

### Storage

Sessions, notes, settings, customisation, summaries, and generated documents are handled in-browser only. By default, local data is stored in browser local storage. FHIR exports are generated on demand for download and are not persisted by the app unless the user chooses to keep the downloaded file.

The app now also supports optional local privacy protections for session data:

- Encrypted storage at rest for saved session history using AES-GCM via the browser Web Crypto API.
- Passphrase unlock mode, which allows encrypted history to be reopened after refresh.
- Session-only key mode, which keeps the key in memory only and makes encrypted history unavailable after refresh.
- App-level lock and unlock behaviour, including automatic locking after inactivity.
- Ephemeral consultation mode for memory-only sessions until the user explicitly saves them.
- Retention-based cleanup, delete archived sessions, delete all sessions, and best-effort purge on browser close.

## Privacy

This app does not send transcript, summary, document, or FHIR export data to any backend controlled by this project. AI summaries and document generation use Chrome's on-device model and do not rely on external AI services.
Additional notes:

- Session data is stored locally in the browser.
- Saved session history can optionally be encrypted before it is written to local storage.
- Sensitive consultation content can be hidden behind an in-app lock screen while the tab remains open.
- Local deletion and retention controls are user-driven and happen in the browser only.
- The initial built-in model download is managed by Chrome, not by this app.
- Speech transcription uses the browser's speech recognition engine. If you need a stricter privacy statement for transcription itself, verify the behaviour of that browser feature in your target deployment environment before making broader claims.

## Troubleshooting

### `LanguageModel` or `Summarizer` is undefined

- Make sure the app is running on `localhost`.
- Confirm the required Chrome flags are enabled.
- Relaunch Chrome after changing flags.
- Check `chrome://on-device-internals`.
- Run `LanguageModel.availability(...)` in DevTools to confirm whether the model is available or still downloading.

### The model never becomes available

- Check that the device meets Chrome's hardware requirements.
- Confirm there is sufficient free disk space.
- Make sure the first model download can occur over an unmetered connection.

### Document or summary generation fails

- Confirm the selected session is stopped and contains transcript content.
- Check that Prompt API is available in the current Chrome build.
- Review DevTools for availability or permission-related errors.

### Speech recognition does not start

- This prototype currently depends on Chrome speech recognition support.
- If speech recognition is unavailable, the app can still be used for manual notes, history, local summaries from existing transcript content, and document drafting from saved sessions.

## Architecture

- Frontend: HTML + JavaScript
- Transcription: Browser speech recognition
- AI: Chrome built-in Prompt API (on-device Gemini Nano)
- Interoperability export: Client-side FHIR R4 JSON Bundle generation
- Storage: Browser local storage

## Roadmap

Possible next steps for the prototype:

- Better surfacing of model download and readiness state in the UI.
- More document templates and template versioning.
- Additional interoperability exports beyond the current plain text, HTML, and FHIR JSON outputs.
- Clearer browser capability diagnostics for transcription, Prompt API, and Summarizer fallback.
- Improved session search, filtering, and document management across history.
- Optional packaging as a local desktop wrapper or PWA for easier deployment.

## Known Limitations

- Depends on Chrome built-in AI APIs that are still evolving and may change.
- Requires relatively modern hardware to run on-device models.
- Speech recognition behaviour depends on the browser implementation.
- Not suitable for clinical use.

## References

- Chrome built-in AI getting started: https://developer.chrome.com/docs/ai/get-started
- Chrome Prompt API: https://developer.chrome.com/docs/ai/prompt-api
- Chrome client-side translation overview: https://developer.chrome.com/docs/ai/translate-on-device

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Disclaimer

This project is provided for educational and experimental purposes only.
It is not a medical device and must not be used for diagnosis or clinical decision-making.