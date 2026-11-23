"""Draws the two demo pictures that have no photo: demo-liquor.webp and demo-hardware.webp (800x450), as illustrated scenes.
   python3 tools/make-demo-scenes.py        (needs playwright + chromium for rendering)
They are drawings, not photographs: replace them with real photos any time (same file names)."""
import random, math
from playwright.sync_api import sync_playwright
from PIL import Image
import io

def liquor():
    r = random.Random(7)
    o = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450" width="800" height="450">',
         '<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a0d08"/><stop offset="1" stop-color="#3a1d10"/></linearGradient>'
         '<radialGradient id="glow" cx="0.62" cy="0.45" r="0.7"><stop offset="0" stop-color="#ffb347" stop-opacity=".55"/><stop offset="1" stop-color="#ffb347" stop-opacity="0"/></radialGradient>'
         '<linearGradient id="wood" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8a5a33"/><stop offset="1" stop-color="#4b2c15"/></linearGradient>'
         '<linearGradient id="vig" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#120804" stop-opacity=".85"/><stop offset=".55" stop-color="#120804" stop-opacity="0"/></linearGradient></defs>',
         '<rect width="800" height="450" fill="url(#bg)"/><rect width="800" height="450" fill="url(#glow)"/>']
    for i in range(26):                                                    # warm bokeh lights
        o.append(f'<circle cx="{r.randint(300,790)}" cy="{r.randint(10,420)}" r="{r.randint(6,22)}" fill="#ffc46b" opacity="{r.uniform(.05,.16):.2f}"/>')
    palettes = [('#2f6b3a', '#d8c27a'), ('#6b2a1f', '#e8d9b0'), ('#1f3f6b', '#f0f0f0'), ('#7a5a1a', '#2a1a08'), ('#3b2a52', '#e8d9b0'), ('#9a6a1a', '#fff3d0'), ('#2c2c2c', '#c9a24b'), ('#5a1f2f', '#f0e6d2')]
    for row, y in enumerate((118, 255, 392)):
        o.append(f'<rect x="0" y="{y}" width="800" height="12" fill="url(#wood)"/><rect x="0" y="{y+12}" width="800" height="6" fill="#ffb347" opacity=".22"/>')
        x = 250 + r.randint(0, 20)
        while x < 790:
            body, label = r.choice(palettes); kind = r.choice(['tall', 'tall', 'wide', 'round'])
            w = {'tall': 40, 'wide': 52, 'round': 58}[kind] + r.randint(-4, 6); h = {'tall': 98, 'wide': 76, 'round': 66}[kind] + r.randint(-6, 10)
            top = y - h; nw = 14 if kind != 'round' else 18
            neck = f'<rect x="{x+w/2-nw/2}" y="{top-34}" width="{nw}" height="40" rx="4" fill="{body}"/><rect x="{x+w/2-nw/2-1}" y="{top-40}" width="{nw+2}" height="9" rx="2" fill="{r.choice(["#c9a24b","#b0b0b0","#222"])}"/>'
            o.append(f'<g>{neck}<rect x="{x}" y="{top}" width="{w}" height="{h}" rx="{10 if kind!="round" else 22}" fill="{body}"/>'
                     f'<rect x="{x+5}" y="{top+h*0.28}" width="{w-10}" height="{h*0.36}" rx="3" fill="{label}" opacity=".92"/>'
                     f'<rect x="{x+9}" y="{top+h*0.38}" width="{w-18}" height="3" fill="{body}" opacity=".55"/><rect x="{x+9}" y="{top+h*0.48}" width="{(w-18)*.6}" height="3" fill="{body}" opacity=".4"/>'
                     f'<rect x="{x+4}" y="{top+6}" width="5" height="{h-14}" rx="2.5" fill="#fff" opacity=".22"/></g>')
            x += w + r.randint(6, 16)
    o.append('<rect width="800" height="450" fill="url(#vig)"/></svg>')
    return '\n'.join(o)

def hardware():
    r = random.Random(11)
    o = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450" width="800" height="450">',
         '<defs><pattern id="peg" width="22" height="22" patternUnits="userSpaceOnUse"><rect width="22" height="22" fill="#46525e"/><circle cx="11" cy="11" r="2.6" fill="#2b343c"/></pattern>'
         '<linearGradient id="steel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e9eef2"/><stop offset=".5" stop-color="#a9b4bd"/><stop offset="1" stop-color="#6d7882"/></linearGradient>'
         '<linearGradient id="wd" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#c88a4a"/><stop offset="1" stop-color="#8a5a2b"/></linearGradient>'
         '<linearGradient id="vig" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#10161c" stop-opacity=".85"/><stop offset=".55" stop-color="#10161c" stop-opacity="0"/></linearGradient>'
         '<radialGradient id="lt" cx=".7" cy=".35" r=".8"><stop offset="0" stop-color="#fff3d6" stop-opacity=".35"/><stop offset="1" stop-color="#fff3d6" stop-opacity="0"/></radialGradient></defs>',
         '<rect width="800" height="450" fill="url(#peg)"/><rect width="800" height="450" fill="url(#lt)"/>']
    # hammer
    o.append('<g transform="translate(300,60) rotate(18 60 120)"><rect x="52" y="40" width="16" height="190" rx="7" fill="url(#wd)"/><rect x="20" y="14" width="86" height="34" rx="5" fill="url(#steel)"/><path d="M106 18 L140 10 L140 44 L106 44 Z" fill="url(#steel)"/><rect x="26" y="20" width="10" height="22" fill="#fff" opacity=".35"/></g>')
    # handsaw
    o.append('<g transform="translate(470,48) rotate(-8)"><path d="M0 60 L250 30 L250 120 L0 130 Z" fill="url(#steel)"/>' + ''.join(f'<path d="M{i*12} {60+i*0.0} l6 14 l6 -14" fill="#7d8791"/>' for i in range(0, 20)) + '<path d="M0 60 L0 130 L-34 140 Q-52 96 -34 56 Z" fill="#d6531f"/><circle cx="-24" cy="98" r="9" fill="#46525e"/></g>')
    # wrench
    o.append('<g transform="translate(585,178) rotate(40)"><rect x="0" y="40" width="170" height="22" rx="10" fill="url(#steel)"/><path d="M170 30 q40 -10 44 28 q-4 38 -44 28 l-10 -14 l22 -14 l-22 -14 Z" fill="url(#steel)"/></g>')
    # screwdrivers
    for i, c in enumerate(('#e3342f', '#2b7de9', '#f2b705')):
        o.append(f'<g transform="translate({340+i*34},250)"><rect x="0" y="0" width="16" height="70" rx="7" fill="{c}"/><rect x="5" y="70" width="6" height="62" fill="url(#steel)"/><rect x="2" y="12" width="12" height="4" fill="#fff" opacity=".4"/></g>')
    # shelf with paint cans + nail boxes
    o.append('<rect x="250" y="400" width="550" height="14" fill="url(#wd)"/><rect x="250" y="414" width="550" height="8" fill="#000" opacity=".25"/>')
    for i, c in enumerate(('#d6531f', '#2b7de9', '#2f9e5a', '#f2b705', '#e3342f')):
        x = 350 + i * 70
        o.append(f'<g><rect x="{x}" y="338" width="54" height="62" rx="4" fill="#cfd6db"/><rect x="{x}" y="338" width="54" height="10" rx="3" fill="#aab4bb"/><rect x="{x+4}" y="356" width="46" height="28" rx="3" fill="{c}"/><rect x="{x+10}" y="364" width="34" height="4" fill="#fff" opacity=".8"/><rect x="{x+6}" y="344" width="5" height="52" fill="#fff" opacity=".25"/></g>')
    o.append('<g><rect x="716" y="352" width="70" height="48" rx="3" fill="#e9a23b"/><rect x="724" y="362" width="54" height="14" fill="#fff" opacity=".85"/><rect x="724" y="382" width="34" height="5" fill="#46525e"/></g>')
    # tape measure
    o.append('<g transform="translate(262,340)"><rect x="0" y="0" width="70" height="60" rx="14" fill="#f2b705"/><circle cx="26" cy="30" r="14" fill="#2b343c"/><rect x="50" y="40" width="34" height="12" fill="#e8e8e8"/></g>')
    o.append('<rect width="800" height="450" fill="url(#vig)"/></svg>')
    return '\n'.join(o)

with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 800, 'height': 450})
    for name, svg in (('liquor', liquor()), ('hardware', hardware())):
        pg.set_content(f'<body style="margin:0;background:#000">{svg}</body>')
        Image.open(io.BytesIO(pg.screenshot(clip={'x': 0, 'y': 0, 'width': 800, 'height': 450}))).convert('RGB').save(f'public-site/img/demo-{name}.webp', 'WEBP', quality=84, method=6)
        print('wrote demo-%s.webp' % name)
    b.close()
