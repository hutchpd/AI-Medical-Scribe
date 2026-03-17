# AI Medical Scribe

AI Medical Scribe is a browser-based prototype for live consultation transcription, on-device summarisation, and document drafting.

It is designed as a local-first front end. Session capture, notes, summaries, generated documents, settings, and customisation are all handled in the browser with no project backend.

## Features

- Live consultation transcription using Chrome's speech recognition support.
- Manual note capture alongside the live transcript.
- Important-moment markers inside the transcript timeline.
- On-device AI summary generation after transcription stops.
- Rich text document drafting from transcript content using configurable templates.
- Session history with review, edit, duplicate, archive, and delete workflows.
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

Yes — definitely update the README 👍

What you’ve discovered is actually quite useful, and worth documenting properly. Right now your README slightly over-constrains people.

---

# 🧠 The key point

There are **two valid ways to run your app**:

### ✅ 1. Open directly via `file://`

* Works for your current setup
* Zero friction
* Ideal for non-technical users testing locally

### ⚠️ 2. Serve via `localhost`

* Needed for:

  * some Chrome AI API behaviours
  * future compatibility
  * stricter browser environments

---

# 🟢 What I would change

Don’t remove the server instructions — just **add `file://` as the simplest option** and position it first.

---

# ✍️ Suggested rewrite (drop-in replacement)

Replace your current section:

```md
### 1. Serve the app on localhost
```

With:

````md
### 1. Run the app locally

You can run the app in two ways:

#### Option A: Open directly (simplest)

Open the HTML file directly in Chrome, simply download the zip file, extract and open ai_medical_scribe.html

```text
file:///path/to/ai_medical_scribe.html
````

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

## How It Works

### Transcription

Live transcription uses `webkitSpeechRecognition` when it is available in the browser.

### Summaries

Consultation summaries are generated on-device using Chrome's Prompt API when available, with Summarizer API fallback support in this prototype.

### Documents

Document drafts are generated from the transcript using Chrome's on-device model path and stored as editable rich text HTML.

### Storage

Sessions, notes, settings, customisation, summaries, and generated documents are persisted in browser local storage only.

## Privacy

This app does not send transcript, summary, or document data to any backend controlled by this project. AI summaries and document generation use Chrome's on-device model and do not rely on external AI services.
Additional notes:

- Session data is stored locally in the browser.
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

## Roadmap

Possible next steps for the prototype:

- Better surfacing of model download and readiness state in the UI.
- More document templates and template versioning.
- Structured export formats in addition to plain text and HTML.
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