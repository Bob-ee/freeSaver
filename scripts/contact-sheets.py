#!/usr/bin/env python3
"""Builds numbered contact sheets of the whole catalogue for reviewing by eye.

    python3 scripts/contact-sheets.py

Needs Pillow. Reads app/art.json and scripts/.cache/thumbs.json (written by
`npm run art:refresh`), downloads each thumbnail once, and writes
scripts/.cache/sheets/sheet-NNN.jpg plus index.json, which maps every number
on a sheet back to the work. Each cell is cropped to 16:9, the way the TV
shows it. Add works you do not want to scripts/rejects.json.
"""
import io
import json
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, '.cache')
THUMBS = os.path.join(CACHE, 'thumb-images')
SHEETS = os.path.join(CACHE, 'sheets')
COLS, ROWS, CELL_W, CELL_H, PAD = 6, 5, 400, 225, 6
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')


def fetch(job):
    number, url = job
    path = os.path.join(THUMBS, '%05d.jpg' % number)
    if os.path.exists(path):
        return
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        data = urllib.request.urlopen(req, timeout=40).read()
        im = Image.open(io.BytesIO(data)).convert('RGB')
        # Crop to 16:9 from the centre, as the app does.
        w, h = im.size
        if w / h > 16 / 9:
            nw = int(h * 16 / 9)
            im = im.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
        else:
            nh = int(w * 9 / 16)
            im = im.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
        im.resize((CELL_W, CELL_H), Image.LANCZOS).save(path, quality=85)
    except Exception as err:  # noqa: BLE001 - one bad thumbnail must not stop the run
        print('  could not fetch #%d: %s' % (number, err), file=sys.stderr)


def main():
    art = json.load(open(os.path.join(ROOT, 'app', 'art.json')))
    thumbs = json.load(open(os.path.join(CACHE, 'thumbs.json')))
    works = art['works']
    os.makedirs(THUMBS, exist_ok=True)
    os.makedirs(SHEETS, exist_ok=True)
    for old in os.listdir(SHEETS):
        os.remove(os.path.join(SHEETS, old))
    for old in os.listdir(THUMBS):
        os.remove(os.path.join(THUMBS, old))  # numbering changes whenever the catalogue does

    jobs = [(i, thumbs.get(w['src'][0]) or w['src'][-1]) for i, w in enumerate(works)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(fetch, jobs))

    try:
        font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 22)
    except OSError:
        font = ImageFont.load_default()
    per = COLS * ROWS
    index = {}
    for s in range(0, len(works), per):
        sheet = Image.new('RGB', (COLS * (CELL_W + PAD) + PAD, ROWS * (CELL_H + PAD) + PAD), (24, 24, 24))
        draw = ImageDraw.Draw(sheet)
        for k, i in enumerate(range(s, min(s + per, len(works)))):
            x = PAD + (k % COLS) * (CELL_W + PAD)
            y = PAD + (k // COLS) * (CELL_H + PAD)
            path = os.path.join(THUMBS, '%05d.jpg' % i)
            if os.path.exists(path):
                sheet.paste(Image.open(path), (x, y))
            label = str(i)
            box = draw.textbbox((0, 0), label, font=font)
            draw.rectangle([x, y, x + box[2] + 12, y + box[3] + 10], fill=(0, 0, 0))
            draw.text((x + 6, y + 3), label, fill=(255, 255, 255), font=font)
            w = works[i]
            index[i] = {'src': w['src'][0], 'title': w['title'], 'sub': w['sub'],
                        'cats': w['cats'], 'source': w['source']}
        sheet.save(os.path.join(SHEETS, 'sheet-%03d.jpg' % (s // per)), quality=82)
    json.dump(index, open(os.path.join(SHEETS, 'index.json'), 'w'))
    print('%d works on %d sheets in %s' % (len(works), (len(works) + per - 1) // per, SHEETS))


if __name__ == '__main__':
    main()
