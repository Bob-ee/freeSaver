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
| Your photos | Sent from your phone, or a shared album | Yours |

The catalogue of works ships inside the app; the images themselves load from
each museum's own image server. Works are filtered to fit a 16:9 screen.
Every work was then scored for brightness and colour variety and looked at by
eye, and the stronger ones form the default selection, **Best picks only**.
Nothing is removed: turn that switch off in the menu to see everything,
including old photographs, sketches and darker works. Works with violent or
explicit subjects sit behind a separate **Mature themes** switch.

## Features

- Pictures crop to fill the screen, with a slow drift so nothing sits still.
- Picture frames (walnut, oak, black lacquer, gilt, thin float) drawn in CSS:
  one per session, a rotating mix, or none.
- Generative art in 15 styles and two moods (vivid and quiet).
- A varied rotation: the same kind of picture never comes up twice in a row.
- Everything is set on the TV with the remote: categories, sources, frame,
  "vivid only", picture interval, brightness, night dimming, titles, clock.
- Add your own photos from your phone by scanning a code on the TV, or link
  a shared album (Immich, Google Photos, iCloud).
- A curated selection by default; one switch shows everything in the
  catalogue.
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

No computer needed. In the menu choose **Add photos from your phone**: the TV
shows a QR code, and scanning it opens a page served by the TV itself. From
there you can

- **send photos** from your phone. They are resized on the phone and stored
  on the TV (up to 500);
- **link a shared album** and the TV keeps it up to date: Immich share links,
  Google Photos shared albums, and iCloud Shared Albums with a public
  website link;
- delete photos and remove albums.

Your phone and TV need to be on the same Wi-Fi. Photos travel straight from
the phone to the TV; nothing is uploaded to a service of ours, and there is
no account. The page only works while freeSaver is open on the TV, and only
for someone holding the link in the QR code.

Notes on albums: Google offers no official way to read a shared album, so
that one reads the public album page, shows the first 300 or so photos, and
may break if Google changes the page. iCloud support was written from the
public shared-album format and has not yet been confirmed against a live
album.

Building it yourself, you can also put pictures in `photos/` before
`npm run deploy` to bake them into the package.

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
