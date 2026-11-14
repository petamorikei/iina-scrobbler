# Scrobbler for IINA

An [IINA](https://iina.io/) plugin that scrobbles what you play to [Last.fm](https://www.last.fm/): local music
files, music videos, and online videos played through yt-dlp (YouTube and others).

- Connect once from the **Plugin** menu and allow access in your browser. No API key of your own is needed.
- Scrobbles with the same rules as [Web Scrobbler](https://github.com/web-scrobbler/web-scrobbler): tracks shorter
  than 30 seconds are skipped, and a track is scrobbled after half its length or 4 minutes of playback, whichever
  comes first. Paused time and skipped-over parts do not count.
- Like Web Scrobbler, scrobbles only tracks Last.fm knows (checked with `track.getInfo`); a setting scrobbles
  everything instead.
- Live streams and internet radio are scrobbled after 30 seconds, as their length is unknown; radio song by song.
- Sends "now playing" while a track plays.
- Scrobbles made while offline or before connecting are kept in a queue and sent later (retrying with backoff, for up
  to 14 days, which is as far back as Last.fm accepts).
- Reads artist / title / album from tags. For untagged audio files it falls back to the file name
  (`01 - Artist - Title.mp3`).
- For online videos it asks yt-dlp for the music metadata (YouTube Music fields, the "Provided to YouTube by"
  description, then the video title and channel name).

## Requirements

- [IINA](https://iina.io/) 1.4 or later (tested with IINA 1.5.1)
- For online videos: IINA's **Online Media** plugin (the default way IINA plays URLs through yt-dlp). A newer yt-dlp
  installed with Homebrew is used automatically when present.

## Installation

Either:

- In **IINA › Settings › Plugins**, install from GitHub and enter `petamorikei/iina-scrobbler`. IINA installs the
  package from the latest release and can check for updates later; or
- download `iina-scrobbler-<version>.iinaplgz` from the
  [latest release](https://github.com/petamorikei/iina-scrobbler/releases/latest) and open it.

Then:

1. Choose **Plugin › Connect to Last.fm…**.
2. Allow access on the Last.fm page that opens in your browser.
3. After a few seconds the Plugin menu shows **Last.fm: connected as _your name_**.

To disconnect, choose **Plugin › Disconnect from Last.fm**.

## What is scrobbled

| Source                                                  | Scrobbled when                                                                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Local audio files                                       | the file has artist and title tags, or the file name looks like `Artist - Title`                                                             |
| Local video files                                       | the file has artist and title tags (file names are not used, so episodes are not scrobbled)                                                  |
| Online videos via yt-dlp                                | yt-dlp or the video title yields an artist and a title (as in Web Scrobbler, the channel name is used as the artist when the title has none) |
| Other network media (direct links to audio/video files) | as for local files                                                                                                                           |
| Live streams (via yt-dlp or a direct link)              | as above, after 30 seconds of playback (the length is unknown)                                                                               |
| Internet radio (ICY)                                    | each song whose stream title looks like `Artist - Title`, after 30 seconds                                                                   |

In every case, the track is scrobbled only if Last.fm knows the artist and title (Web Scrobbler's default, "Scrobble
recognized tracks"). This also filters out wrong guesses from file names and video titles. Turn on "Also scrobble
tracks Last.fm does not know" to scrobble them anyway. If the check cannot run (offline), the track is kept and checked
again before it is sent.

Each source can be turned off in **IINA › Settings › Plugins › Scrobbler**. Turn off "Online videos played through
yt-dlp" if you do not want non-music videos to be scrobbled as "channel – title".

## Settings

| Setting                                     | Default   | Description                                                                                                                                     |
| ------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Local files / Online videos / Other network | on        | Which sources are scrobbled                                                                                                                     |
| Also scrobble tracks Last.fm does not know  | off       | Skip the Last.fm check and scrobble every track (Web Scrobbler's "Force track recognition")                                                     |
| Run yt-dlp to read artist, track and album  | on        | Online Media only passes the video title; with this on the plugin runs yt-dlp once per video (about 2 seconds)                                  |
| yt-dlp path                                 | automatic | `/opt/homebrew/bin/yt-dlp`, `/usr/local/bin/yt-dlp`, then the copy bundled with IINA                                                            |
| Show a message on screen                    | on        | On-screen message when a track is scrobbled                                                                                                     |
| Write a debug log                           | off       | Writes `debug-*.log` to `~/Library/Application Support/com.colliderli.iina/plugins/.data/io.github.petamorikei.iina-scrobbler/` for bug reports |

## Privacy

- The plugin talks only to `ws.audioscrobbler.com` (Last.fm). Your browser opens `www.last.fm` once to approve access.
- For online videos, the yt-dlp it runs fetches the video page's metadata from the video site (once per video). Turn
  off "Run yt-dlp to read artist, track and album" to avoid that.
- Your Last.fm session key is stored in IINA's plugin preferences on your Mac. It is never written to logs.
- The scrobble queue is stored in the plugin's data folder (`queue.json`).

## Known limitations

- Scrobbling per chapter (several songs in one video) is not supported.
- Internet radio song titles change when the song enters the buffer, a few seconds before it is heard.
- If two IINA processes run at the same time, a queued scrobble can occasionally be sent twice.
- The plugin's menus and messages are in English only.

## Development

Tools are managed with [mise](https://mise.jdx.dev/) and dependencies with pnpm.

```sh
mise install                 # Node, pnpm, prek
cp .env.example .env         # then fill in your Last.fm API account (https://www.last.fm/api/account/create)
mise run build               # dist/main.js and dist/global.js
mise run link                # load this folder into IINA as a development plugin
mise run check               # Biome, type-check, unit tests (Vitest)
mise run pack                # out/iina-scrobbler-<version>.iinaplgz
```

- `mise run build:nosecrets` builds without Last.fm credentials (connecting is then disabled).
- The Last.fm API key and secret are embedded into `dist/global.js` at build time and are never committed.
- Functions are written as arrow functions only (enforced by Biome).
- Design notes and the findings from testing on a real IINA are in [`docs/`](docs/) (Japanese). They record several
  IINA plugin pitfalls, for example that calling `menu.forceUpdate()` while the global entry is loading silently
  breaks messages from player instances.
- `probe/` is the throwaway plugin that was used to verify IINA's behaviour.

### Releasing

1. Raise `version` in `package.json` and `Info.json` (same value), and increase `ghVersion` in `Info.json` by one.
   IINA offers an update when `ghVersion` on `main` is higher than the installed one.
2. Commit, push to `main`, then push a tag `v<version>` (for example `v0.2.0`).
3. The [Release workflow](.github/workflows/release.yml) checks the versions, runs the checks, builds with the
   `LASTFM_API_KEY` / `LASTFM_API_SECRET` repository secrets and publishes the release with the `.iinaplgz`
   attached.

## License

[MIT](LICENSE). Parts are ported from Web Scrobbler (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
