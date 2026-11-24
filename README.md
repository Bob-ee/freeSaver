# freeSaver

A free art and photo frame for LG webOS TVs. It turns the TV into a picture
frame: museum paintings, photography, space imagery, your own photos, and
abstract art drawn fresh by code, shown one at a time inside an optional
drawn picture frame.

No subscription, no account, no ads.

> Tested on one TV so far: an LG G4 OLED running webOS 25. It is a plain web
> app, so other recent webOS TVs should work, but that is untested.

## What it shows

| Source | What | Licence |
| --- | --- | --- |
| Art Institute of Chicago | Paintings, prints, photographs | Public domain (CC0) |
| Cleveland Museum of Art | Paintings, prints, photographs | CC0 |
| National Gallery of Art | Paintings, drawings, photographs | CC0 |
| The Metropolitan Museum of Art | Paintings, prints, photographs | CC0 |
| NASA | Deep sky, planets, Earth from orbit | Public domain (NASA media policy) |
| Generative | Abstract pictures drawn on the TV, new every time | Made on your device |
| Your photos | Anything in the `photos/` folder | Yours |

The catalogue of works ships inside the app; the images themselves load from
each museum's own image server. Works are filtered to fit a 16:9 screen and
scored for brightness and colour so murky ones are left out.

## Features

- Pictures crop to fill the screen, with a slow drift so nothing sits still.
- Picture frames (walnut, oak, black lacquer, gilt, thin float) drawn in CSS:
  one per session, a rotating mix, or none.
- Generative art in 15 styles and two moods (vivid and quiet).
- A varied rotation: the same kind of picture never comes up twice in a row.
- Everything is set on the TV with the remote: categories, sources, frame,
  "vivid only", picture interval, brightness, night dimming, titles, clock.
- Save favourites and play only those; thumbs-down a picture so it never
  comes back.
- Keeps working without internet by drawing generative art.
- Renews its own Developer Mode session, so it stays installed.
- Nothing to run on a computer once it is installed.

## Remote control

| Button | Action |
| --- | --- |
| Left / Right | Previous / next picture |
| OK | Open the menu |
| Up | Save to favourites |
| Down, twice | Never show this picture again |
| Back | Exit |

## Install

You need a Mac or PC with [Node.js](https://nodejs.org) 20 or newer, and the
TV on the same network. Building the catalogue additionally needs `ffmpeg`,
and bundling your own photos uses macOS `sips`.

1. On the TV, install **Developer Mode** from the LG Content Store, sign in
   with a free [LG developer account](https://webostv.developer.lge.com), turn
   **Dev Mode Status** on (the TV restarts), then turn **Key Server** on.
2. On the computer:

   ```sh
   git clone https://github.com/Bob-ee/freeSaver.git
   cd freeSaver
   npm install
   npm run tv:setup -- <TV IP address>   # asks for the passphrase shown on the TV
   npm run deploy
   ```

`npm run deploy` builds the app, installs it and launches it.

### Developer Mode and staying installed

LG removes sideloaded apps when the TV's Developer Mode session runs out
(1,000 hours, about 41 days, on current TVs). freeSaver renews that session
by itself each time it runs, the same as pressing **Extend** in the
Developer Mode app, so it stays installed as long as you open it at least
once every 41 days with the TV online. The menu shows how long is left under
**Help**.

## Your own photos

Put pictures in `photos/` and run `npm run deploy`. They are converted to
JPEG (4K at most) and bundled into the app, so the TV needs nothing else.
That folder is git-ignored.

## Settings

Use the menu on the TV (OK). `app/config.js` only holds the defaults a fresh
install starts with.

## Refreshing the catalogue

```sh
npm run art:refresh            # every source
npm run art:refresh -- nasa    # just one
```

Each source is a small module in `scripts/sources/`. The Met's API is rate
limited, so that one takes about ten minutes.

## Preview in a browser

```sh
cd app && python3 -m http.server 8765
```

Then open <http://127.0.0.1:8765/index.html>. Arrow keys, Enter and Escape
stand in for the remote.

## OLED care

A picture frame is a static shape, so the app looks after the panel: pictures
drift slowly, the frame's edges shift by a pixel or two every quarter of an
hour, and after four hours the frame steps aside for the rest of the session.
For panels prone to burn-in, set **Change frame** in the menu so the frame
style itself rotates, or choose no frame. The TV's own panel care still
applies.

## Licence

MIT. See [LICENSE](LICENSE). The artworks belong to the public domain or to
their respective institutions and photographers as noted above; this project
only links to them.
