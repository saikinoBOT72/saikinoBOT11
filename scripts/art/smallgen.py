#!/usr/bin/env python3
"""ウキ・餌・ビックリマークをドットで直に打つ。輪郭はキャラ・竿と同じ紺。

  python3 scripts/art/smallgen.py public/assets

ウキの2コマは同じ大きさの枠で出す（枠が変わると差し替えたときに飛ぶため）。
"""
import sys, os
from PIL import Image

OUTDIR = sys.argv[1] if len(sys.argv) > 1 else '.'
OUT = (0x02, 0x06, 0x29, 255)
def C(h): return tuple(int(h[i:i+2], 16) for i in (1, 3, 5)) + (255,)

RED, RED_D, RED_L = C('#D8443A'), C('#96261F'), C('#F08079')
CRM, CRM_D        = C('#F1E6D2'), C('#B9A98F')
ANT, ANT_L        = C('#F5D76E'), C('#FBEFA8')
PNK, PNK_D, PNK_L = C('#C9707A'), C('#8E4550'), C('#E9A7AB')
TIN, TIN_D, TIN_L = C('#9AA7B2'), C('#5E6C79'), C('#D2DBE2')
LBL, LBL_D        = C('#C96F81'), C('#8E4550')

FW, FH = 7, 24                       # ウキの共通の枠

def outline(im, crop=True):
    px = im.load(); w, h = im.size
    ring = [(x, y) for y in range(h) for x in range(w)
            if not px[x, y][3] and any(0 <= x+d[0] < w and 0 <= y+d[1] < h
                                       and px[x+d[0], y+d[1]][3]
                                       for d in ((1,0),(-1,0),(0,1),(0,-1)))]
    for (x, y) in ring: px[x, y] = OUT
    if not crop: return im
    b = im.getchannel('A').point(lambda v: 255 if v >= 128 else 0).getbbox()
    return im.crop(b)

def float_sprite(top, antenna):
    im = Image.new('RGBA', (FW, FH), (0, 0, 0, 0)); px = im.load()
    ox = 2
    if antenna:
        for y in range(top-5, top):
            if 0 <= y < FH: px[ox+1, y] = ANT_L if y % 2 else ANT
    for y in range(top, top+5):
        for x in range(ox, ox+3):
            px[x, y] = RED_L if x == ox else (RED_D if x == ox+2 else RED)
    for y in range(top+5, top+9):
        for x in range(ox, ox+3):
            px[x, y] = CRM if x < ox+2 else CRM_D
    if top+9 < FH: px[ox+1, top+9] = RED_D
    return outline(im, crop=False)

def bait_sprite():
    """餌の缶。ブリキの缶から虫が1匹だけ顔を出している"""
    im = Image.new('RGBA', (18, 18), (0, 0, 0, 0)); px = im.load()
    L, R, TOP, BOT = 4, 12, 7, 16                  # 缶の胴

    for y in range(TOP, BOT):                      # 胴（左が明るい）
        for x in range(L, R):
            px[x, y] = TIN_L if x <= L+1 else (TIN_D if x >= R-2 else TIN)
    for y in (TOP+3, TOP+4, TOP+5):                # 巻いてあるラベル
        for x in range(L, R):
            px[x, y] = LBL_D if x >= R-2 else LBL
    for x in range(L, R):                          # 開いた口のふち
        px[x, TOP-1] = TIN_L if x <= L+1 else TIN_D
    for x in range(L+1, R-1):                      # 中の暗がり
        px[x, TOP] = C('#3A4550')

    worm = [(8, 6), (9, 5), (10, 4), (11, 4), (12, 3), (13, 3), (13, 2)]
    for i, (x, y) in enumerate(worm):              # はみ出している虫
        px[x, y] = PNK_L if i % 3 else PNK
        if 0 <= y+1 < 18 and y+1 < TOP: px[x, y+1] = PNK
    px[13, 2] = PNK_D                              # 頭
    return outline(im)

def alert_sprite():
    """魚がかかったときに頭の上に出すビックリマーク"""
    im = Image.new('RGBA', (7, 13), (0, 0, 0, 0)); px = im.load()
    for y in range(0, 8):                          # 縦棒（下にすぼまる）
        w = 3 if y < 5 else 2
        for x in range(2, 2+w):
            px[x, y] = ANT_L if x == 2 else ANT
    for y in (10, 11):                             # 点
        for x in range(2, 4):
            px[x, y] = ANT_L if x == 2 else ANT
    return outline(im)

made = {
    'float_up':   float_sprite(top=6,  antenna=True),
    'float_down': float_sprite(top=13, antenna=False),
    'bait':       bait_sprite(),
    'alert':      alert_sprite(),
}
os.makedirs(OUTDIR, exist_ok=True)
for n, im in made.items():
    im.save(os.path.join(OUTDIR, n + '.png'))
    print(f'  {n:12s} {im.size[0]:2d}x{im.size[1]:2d}')

S = 12
W = sum(im.width for im in made.values()) + 5*(len(made)-1)
H = max(im.height for im in made.values())
sh = Image.new('RGBA', (W*S, H*S), (255, 255, 255, 255))
x = 0
for im in made.values():
    sh.alpha_composite(im.resize((im.width*S, im.height*S), Image.NEAREST), (x*S, (H-im.height)*S))
    x += im.width + 5
sh.save('/tmp/small_preview.png')
