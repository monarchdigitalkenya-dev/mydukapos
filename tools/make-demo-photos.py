"""Builds public-site/img/demo-<key>.webp (the live-demo gallery cards, 16:9, 800x450) from the product-card photos
(public-site/img/card-<key>-1200.webp, themselves made by tools/make-card-images.py). A soft tint on the left hides the smoothed text zone.
Demos with no matching photo (hardware, liquor) keep their drawn picture (demo-<key>.svg) until you add demo-<key>.webp yourself."""
import json
from PIL import Image
import numpy as np
MAP = {'retail': 'shop', 'hotel': 'hotel', 'hospital': 'hospital', 'production': 'production', 'pharmacy': 'pharmacy', 'services': 'services', 'water': 'water'}
TOP = {'hospital': 0}                       # keep the doctor's head in frame
tint = {c['key']: [int(v) for v in c['tint'].split(',')] for c in json.load(open('public-site/product-cards.json'))['cards']}
for demo, card in MAP.items():
    im = Image.open(f'public-site/img/card-{card}-1200.webp').convert('RGB')
    top = TOP.get(demo, 50)
    im = im.crop((0, top, 1200, top + 675)).resize((800, 450), Image.LANCZOS)
    a = np.array(im).astype(float)
    x = np.linspace(0, 1, 800)[None, :, None]
    alpha = np.clip(0.80 * (1 - x / 0.62), 0, 0.80)           # strongest at the left edge, gone by 62% of the width
    a = a * (1 - alpha) + np.array(tint[card], float)[None, None, :] * alpha
    Image.fromarray(a.astype('uint8')).save(f'public-site/img/demo-{demo}.webp', 'WEBP', quality=80, method=6)
    print(demo, '<-', card)
