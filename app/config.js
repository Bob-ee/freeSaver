// freeSaver settings. Edit, then run `npm run deploy` again.
//
// These are the defaults. Everything here can also be changed on the TV
// itself: press OK on the remote. Choices made there are remembered and win.
window.ARTFRAME_CONFIG = {
  // 'all', or a list picked from:
  //   'landscapes', 'seascapes', 'cities', 'impressionism', 'still-life',
  //   'portraits', 'japanese-prints', 'modern-abstract', 'botanical-animals',
  //   'photography', 'space'
  categories: 'all',

  // 'all', or a list of source ids (see scripts/sources/), e.g. ['met', 'nasa'].
  sources: 'all',

  // Only show the most colourful works from the catalogue.
  vividOnly: false,

  // Mix in abstract pictures drawn by code (a new one every time).
  generative: true,

  // Include pictures from the photos/ folder.
  myPhotos: true,

  // Pictures are cropped to fill the 16:9 screen. Museum works that would
  // lose more than this share of the picture (0.25 = a quarter) are left out
  // of the rotation. Your own landscape photos always fill the screen.
  maxCrop: 0.3,

  // Picture frame drawn around the art. 'random' picks one each time the app
  // starts and keeps it for that session (see frameChangeMinutes below). Or 'none', 'walnut', 'oak',
  // 'ebony', 'gilt', 'float'. Can also be changed from the chooser.
  frame: 'random',

  // Minutes each picture stays on screen.
  minutesPerPhoto: 5,

  // Seconds for the crossfade between pictures.
  fadeSeconds: 3,

  // Very slow drift/zoom while a picture is shown. Looks alive and keeps
  // pixels moving, which is kinder to an OLED panel than a frozen image.
  drift: true,

  // Overall brightness, 0.2 - 1. Lower looks more like a print on a wall.
  brightness: 0.85,

  // Dim further at night. Hours are 0-23 in the TV's local time.
  night: { from: 22, to: 7, brightness: 0.45 },

  // "never", "onChange" (shows briefly when the picture changes), or "always".
  // Skipping with left/right always shows it briefly.
  caption: 'never',

  // Small clock in the corner.
  clock: false,

  // With the frame on 'random': how often to switch to a different frame
  // style, in minutes. 0 keeps one frame for the whole session. On panels
  // prone to burn-in, changing it now and then spreads the wear.
  frameChangeMinutes: 0,

  // OLED care: hours after which the picture frame steps aside for the rest
  // of the session (0 = never). The frame is the one thing that never moves.
  frameRestHours: 4
};
