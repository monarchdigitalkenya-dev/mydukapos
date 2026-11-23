"""Builds public-site/img/card-<key>-{640,1200}.webp from the sample board (the screenshot of the seven reference cards).
   python3 tools/make-card-images.py path/to/sample.jpeg
The sample has the card text baked into each picture; this crops each card, paints the white text and the icon out (OpenCV inpainting) and
resizes to 3:2. The sample is only ~490 px wide per card, so the 1200 px files are an upscale: they look soft. Replace them with real
photographs when you have them (docs/CARD-IMAGES.md); the file names stay the same."""
import sys, numpy as np, cv2
from PIL import Image, ImageFilter
from scipy import ndimage

SRC = sys.argv[1]
OUT = 'public-site/img/'
# key: (card box in the sample, how far right the TITLE reaches, how far right the small text reaches)
CARDS = {
  'shop':       ((15, 16, 509, 345), 0.46, 0.80),
  'hotel':      ((521, 16, 1016, 343), 0.76, 0.76),
  'hospital':   ((1028, 16, 1521, 343), 0.56, 0.80),
  'production': ((15, 356, 510, 685), 0.56, 0.86),
  'pharmacy':   ((521, 356, 1017, 684), 0.56, 0.78),
  'services':   ((1028, 356, 1521, 685), 1.00, 0.84),
  'water':      ((15, 697, 777, 999), 0.64, 0.64),
}
im = np.array(Image.open(SRC).convert('RGB'))
for key, ((x0, y0, x1, y1), t_reach, s_reach) in CARDS.items():
    card = im[y0 + 8:y1 - 8, x0 + 8:x1 - 8].copy()
    h, w = card.shape[:2]
    mn, mx = card.min(axis=2).astype(int), card.max(axis=2).astype(int)
    white = (mn > 170) & ((mx - mn) < 75)
    # thin strokes (small text) are told apart from bright photo areas (screens, shelves, coats), which are blobs: only strokes are painted out
    blobs = ndimage.binary_dilation(ndimage.binary_opening(white, structure=np.ones((3, 3)), iterations=2), iterations=2)
    strokes = white & ~blobs
    mask = np.zeros((h, w), bool)
    mask[100:178, :int(w * t_reach)] = white[100:178, :int(w * t_reach)]            # the bold title
    mask[178:, :int(w * s_reach)] = strokes[178:, :int(w * s_reach)]                  # description + "See details"
    mask[178:, :int(w * 0.30)] |= white[178:, :int(w * 0.30)]                          # (the far left is under the dark tint: paint it all)
    mask[20:125, 8:125] = True                                  # the round icon, top left
    mask = ndimage.binary_dilation(mask, iterations=5)
    bgr = cv2.cvtColor(card, cv2.COLOR_RGB2BGR)
    clean = cv2.inpaint(bgr, (mask * 255).astype(np.uint8), 6, cv2.INPAINT_TELEA)
    # smooth what the painting left behind: blur only inside the (grown) text zone, feathered at its edge
    soft = cv2.GaussianBlur(clean, (0, 0), 7)
    feather = cv2.GaussianBlur(ndimage.binary_dilation(mask, iterations=4).astype(np.float32), (0, 0), 4)[..., None]
    clean = (soft * feather + clean * (1 - feather)).astype(np.uint8)
    img = Image.fromarray(cv2.cvtColor(clean, cv2.COLOR_BGR2RGB))
    # 3:2, keeping the RIGHT side (where the subject is; the text side is covered by the dark overlay)
    tw = int(round(img.height * 1.5)); tw = min(tw, img.width)
    img = img.crop((img.width - tw, 0, img.width, img.height))
    for wpx in (1200, 640):
        o = img.resize((wpx, int(wpx / 1.5)), Image.LANCZOS).filter(ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=2))
        o.save(f'{OUT}card-{key}-{wpx}.webp', 'WEBP', quality=80, method=6)
    print(key, img.size, 'masked %.1f%%' % (100 * mask.mean()))
