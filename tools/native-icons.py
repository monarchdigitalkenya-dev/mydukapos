# Makes each native app's icons from the web app's own icon (icons/icon-512.png of that app) — run once after an icon changes:
#   python3 tools/native-icons.py
# Android: app/src/<flavour>/res/mipmap-*/ic_launcher.png     Windows: native/windows/build/<key>.png (electron-builder makes the .ico)
import json, os
from PIL import Image
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cfg = json.load(open(os.path.join(root, 'native', 'apps.json')))
SIZES = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
for a in cfg['apps']:
    src = Image.open(os.path.join(root, a['icons'], 'icon-512.png')).convert('RGBA')
    for d, px in SIZES.items():
        out = os.path.join(root, 'native', 'android', 'app', 'src', a['key'], 'res', 'mipmap-' + d)
        os.makedirs(out, exist_ok=True)
        src.resize((px, px), Image.LANCZOS).save(os.path.join(out, 'ic_launcher.png'), optimize=True)
    win = os.path.join(root, 'native', 'windows', 'build')
    os.makedirs(win, exist_ok=True)
    src.resize((512, 512), Image.LANCZOS).save(os.path.join(win, a['key'] + '.png'), optimize=True)
    print('icons:', a['key'])
