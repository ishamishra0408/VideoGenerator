# VideoGenerator

Give it a GitHub repo, and optionally a script, and it makes a narrated explainer film of 1, 2, 3 or 4 minutes. The look and the voice follow GitDiagram's own explainer films: lavender paper, ink cards that land on the sentence that names them, and Gemini 3.8 Flash TTS speaking as Charon. Or pick any of the [21st.dev community themes](https://21st.dev/community/themes), light or dark.

No npm install. It's plain TypeScript that Node 22 runs directly, plus ffmpeg and Chrome.

## Run it

You need Node 22.18 or newer, ffmpeg, Google Chrome (or Chromium), and an [OpenRouter](https://openrouter.ai) key.

```bash
cp .env.example .env        # then put your OPENROUTER_API_KEY in it
npm run serve               # serves the web page at http://localhost:4319
```

Or straight from the command line:

```bash
node src/cli.ts --repo owner/name --minutes 2
node src/cli.ts --repo https://github.com/owner/name --script my-script.md
node src/cli.ts --repo ../some-local-folder --minutes 1 --voice say
```

Each film lands in `out/<name>-<n>min/`: the `.mp4`, an `.srt` caption file, `storyboard.json`, the soundtrack and the stage page it was filmed from.

To try the renderer with no key at all, film the bundled storyboard with the Mac's built-in voice:

```bash
node src/cli.ts --from examples/storyboard.json --voice say
```

## The web page

`--serve` starts a page on `127.0.0.1` only. Fill in the repo, pick the length, paste or load a script if you have one, and choose:

- **Write storyboard**: reads the repo and writes the storyboard, then shows it for editing. Change any heading or sentence (one sentence per line), then **Make film**.
- **Make film**: does everything in one go.

Pick a theme under **Theme**: GitDiagram's own, or any 21st.dev community theme in its light or dark version, with its colours and font shown as swatches. Past films are listed underneath, with the MP4 and captions to download. Re-filming an edited storyboard only re-voices the sentences you changed; the rest come from the cache.

## Deploy on Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ishamishra0408/VideoGenerator)

`render.yaml` describes one Docker web service (Node 22, Chromium, ffmpeg). Render asks for two secrets when you create it:

- `OPENROUTER_API_KEY`: pays for the storyboard and the voice.
- `VIDEOGEN_PASSWORD`: 8 or more characters. The page asks for it before anything else, because every film spends the key's credit. The server won't start without it when it listens beyond the machine it runs on.

`GITHUB_TOKEN` is optional, as above. The blueprint uses the free plan, which is small (512 MB, a tenth of a CPU) and sleeps when idle, so films render at 720p in one Chrome tab with a faster encoder, and the page pings the server while a film renders so it stays awake. Nothing is kept across restarts or deploys: download each film when it's done. On a bigger plan, raise `VIDEOGEN_SCALE` to `1` (1080p), `VIDEOGEN_WORKERS` and `VIDEOGEN_PRESET`.

| Variable | Default | |
|---|---|---|
| `HOST`, `PORT` | `127.0.0.1`, `4319` | Where the page listens. The Docker image uses `0.0.0.0:10000`. |
| `VIDEOGEN_PASSWORD` | none | Required unless `HOST` is local |
| `ALLOWED_HOSTS` | Render's own hostname | Extra host names to accept, comma-separated |
| `VIDEOGEN_SCALE` | `1` | `0.6667` films at 720p, `0.5` at 540p |
| `VIDEOGEN_WORKERS` | up to 4 | Chrome tabs filming in parallel |
| `VIDEOGEN_PRESET` | `medium` | x264 preset, e.g. `veryfast` |
| `VIDEOGEN_FPS` | `25` | Frames a second |
| `CHROME_PATH`, `FFMPEG_PATH` | found on the system | |

## Options

| Flag | What it does |
|---|---|
| `--repo` | `owner/name`, a GitHub URL, or a folder on disk |
| `--minutes 1\|2\|3\|4` | The length (default 2). It sets the word budget at 146 words a minute, measured on Charon. |
| `--script <file>` | Your narration, kept word for word. Each paragraph or list item is spoken as its own sentence, and Markdown headings hint where chapters go. With a script, your words set the length, so a long script makes a film longer than 4 minutes. |
| `--adapt` | Fit `--script` to `--minutes` instead of keeping every word |
| `--brief <text>` | Direction for the writer, such as "for a hiring manager" |
| `--theme <name\|link>` | A 21st.dev community theme by name (`vintage-paper`) or link. Default `gitdiagram`. `--themes` lists them. |
| `--mode light\|dark` | The theme's light or dark version (default light) |
| `--voice gemini\|say` | Gemini 3.8 Flash TTS as Charon (default), or macOS `say` offline |
| `--model <slug>` | The OpenRouter model that writes the storyboard (default `anthropic/claude-sonnet-5.5`) |
| `--storyboard-only` | Stop after `storyboard.json`, to edit it by hand |
| `--from <file>` | Film an existing `storyboard.json` |
| `--stills 5,12.5,40` | PNG stills at those seconds instead of the film |
| `--out`, `--fps`, `--workers` | Output folder, frame rate (25), Chrome tabs filming in parallel (default up to 4, at most 8) |
| `--env <file>` | Read keys from another `.env` file |

`GITHUB_TOKEN` in `.env` is optional. It raises GitHub's limit from 60 to 5,000 requests an hour and lets it read private repos you can access.

## How it works

1. **Read.** GitHub's API (or the folder) gives the file tree, the README, the manifests, entry points and a few key source files: about 48,000 characters of README and files, plus a trimmed file tree.
2. **Storyboard.** Claude, through OpenRouter, splits the film into beats and scenes, writes the narration to the word budget, and picks what each scene shows. The result is checked before it's used: the word count, the number of chapters, code that has to be copied from the repo rather than invented, and file paths that have to exist. Problems go back to the writer for up to two more rounds. With your own script, the writer only places your sentences into scenes, and can't change them.
3. **Voice.** One clip per sentence, trimmed of silence and cached by what was said, four at a time.
4. **Sound.** The clips are laid on a clock with pauses between sentences, scenes and chapters. A whoosh at each scene change, a stamp on before-and-after cards, and soft pops and ticks are synthesised and mixed underneath.
5. **Film.** The stage is a single web page that can draw any moment on demand. Headless Chrome seeks it frame by frame, ffmpeg encodes the frames, and the soundtrack is levelled to -16 LUFS.

The stage has nine kinds of scene: a title card, a statement, cards, a flow with wires, a code excerpt with callouts, a file tree, stats, a before-and-after, and a checklist.

## Themes

A theme sets the film's colours, fonts, corner radius and shadows. `gitdiagram` is the built-in look. Any other name is a theme from [21st.dev's community themes](https://21st.dev/community/themes): its light and dark styles are fetched from 21st.dev when you pick it and cached in `.videogen-cache/themes/`. None of them are bundled here. Their shadcn tokens map onto the stage (background, card, foreground, primary, accent, border, destructive). Every text colour is checked against the surface it sits on: an accent that wouldn't read is moved toward the text colour until it reaches 3:1, and body text and labels on tinted cards get 4.5:1 or 3.5:1. The theme's fonts come from Google Fonts and are embedded in the stage page, fetched before anything is paid for, so filming never waits on the network. A font Google doesn't have, or can't be reached for, falls back to a system font, with a note saying which. The theme list is cached for a day, each theme for a week, and fonts until you clear the cache. GitDiagram's own fonts (Geist, Geist Mono, Instrument Serif) load the same way. Changing the theme of a finished film re-films it for free, because the voice is cached.

## Cost

Every run prints what it spent, from OpenRouter's own figures (a run that fails partway records what it had already spent), as one line at the top of the results (and in the terminal), and keeps a running total per film in `cost.json`:

```
cost       0.2¢ this run · voice 0.2¢ (1 new, 9 cached)
```

Only two things cost money. Reading the repo, the sound and the filming run on your machine.

| Step | Price on OpenRouter | Typical |
|---|---|---|
| Storyboard (Claude Sonnet 5.5) | $2 per million tokens in, $10 out | About 15,000 tokens in whatever the length, so an estimated 3 to 5¢ a call. A repair round resends the conversation and costs about the same again. |
| Voice (Gemini 3.8 Flash TTS) | $9 per million audio tokens, about 37 per second of trimmed speech | About 2¢ per minute of narration. Only new sentences are paid for; cached ones are free. |

So a 1-minute film comes to roughly 5 to 6¢ and a 4-minute one 11 to 14¢ (estimates; `cost.json` has the real figure for each film). Re-filming after an edit costs only the changed sentences. An amount marked ≈ was estimated from token counts because OpenRouter hadn't published that call's price yet.

## Tests

```bash
npm test
```

## Credits

The visual language (palette, grid paper, ink cards with hard shadows, serif-italic accents, progress rail, sound cues), the voice (Gemini 3.8 Flash TTS, Charon, and its style direction) and the seek-and-screenshot way of filming all come from [GitDiagram](https://github.com/ahmedkhaleel2004/gitdiagram) by Ahmed Khaleel, MIT licence. The code here is its own.

Themes are the community themes on [21st.dev](https://21st.dev/community/themes), each credited to its author there, and are fetched at run time rather than redistributed. Fonts are served by [Google Fonts](https://fonts.google.com).

## Licence

MIT. See [LICENSE](LICENSE).
