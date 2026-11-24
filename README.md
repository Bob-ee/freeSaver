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
- Picture frames (walnut, oak, black lacquer, gilt, thin float) drawn in CSS,
  one chosen per session, or none.
- Generative art in 15 styles and two moods (vivid and quiet).
- A varied rotation: the same kind of picture never comes up twice in a row.
- On-screen chooser for categories, sources, frame style and "vivid only".
- Thumbs-down any picture so it never comes back.
- Dims at night.

## Remote control

| Button | Action |
| --- | --- |
| Left / Right | Previous / next picture |
| OK | Open the chooser |
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

### Developer Mode expires

LG removes sideloaded apps when the Developer Mode session runs out (1,000
hours on current TVs). Open the Developer Mode app and press **Extend**
before then, or run `npm run deploy` again afterwards.

## Your own photos

Put pictures in `photos/` and run `npm run deploy`. They are converted to
JPEG (4K at most) and bundled into the app. That folder is git-ignored.

## Settings

Edit `app/config.js` and deploy again: minutes per picture, brightness, night
dimming, captions, clock, default categories and frame.

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

A picture frame is a static shape. The app keeps pictures moving and dims the
whole screen, and the TV's own panel care still applies, but if you leave it
on for many hours a day consider the thin frame or no frame.

## Licence

MIT. See [LICENSE](LICENSE). The artworks belong to the public domain or to
their respective institutions and photographers as noted above; this project
only links to them.
