#!/usr/bin/env python3
"""釣り竿8本をドットで直に打つ。

竿の芯を曲線で定義し、その法線方向に太さぶん塗る。
先に太め＋輪郭色で塗ってから本体を上に重ねることで、
きれいな1ドットの輪郭が自動でつく。
"""
from PIL import Image

OUT = (0x02, 0x06, 0x29, 255)          # キャラと同じ輪郭の紺
W, H = 24, 56

def hexc(h): return tuple(int(h[i:i+2], 16) for i in (1, 3, 5)) + (255,)

TIERS = {
 'bamboo': dict(base='#D9A863', shad='#9C6B43', lite='#F0D6A0',
                grip='#8A6034', gacc='#6B4A2F', node='#8A6034'),
 'glass':  dict(base='#6E8496', shad='#42566A', lite='#9FB4C2',
                grip='#33414F', gacc='#222C36'),
 'carbon': dict(base='#3A3945', shad='#22222B', lite='#5A5967',
                grip='#B8362C', gacc='#7E2119'),
 'legend': dict(base='#E8B93F', shad='#A87A1E', lite='#F8E49B',
                grip='#7A5A1C', gacc='#4E3910', gem='#D8443A'),
}

def bez(p0, p1, p2, t):
    u = 1-t
    return (u*u*p0[0] + 2*u*t*p1[0] + t*t*p2[0],
            u*u*p0[1] + 2*u*t*p1[1] + t*t*p2[1])

# 芯の形。idle はほぼまっすぐ、pull は大きくしなって穂先が右下を向く
SHAPE = {
 'idle': ((3, 53), (6, 26), (15, 1)),
 'pull': ((3, 53), (18, 14), (19, 32)),  # 右へ張り出し、穂先が魚に引かれて下を向く
}

def draw(tier, state):
    c = TIERS[tier]
    p0, p1, p2 = SHAPE[state]
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    px = im.load()
    def put(x, y, col):
        x, y = int(round(x)), int(round(y))
        if 0 <= x < W and 0 <= y < H: px[x, y] = col

    STEPS = 900
    def sweep(pad, colf):
        for i in range(STEPS+1):
            t = i/STEPS
            x, y = bez(p0, p1, p2, t)
            dx, dy = bez(p0, p1, p2, min(1, t+.002))
            ex, ey = dx-x, dy-y
            L = (ex*ex+ey*ey) ** .5 or 1
            nx, ny = -ey/L, ex/L                     # 芯に垂直な向き
            r = (0.95*(1-t)**1.4 + 0.30) + pad       # 根元は太く、穂先は1ドットまで
            k = int(r*3)+2
            for j in range(-k, k+1):
                o = j/3
                if abs(o) > r: continue
                put(x+nx*o, y+ny*o, colf(t, o/r))

    def body(t, n):
        if t < 0.13:                                 # グリップ
            return hexc(c['gacc']) if n > .1 else hexc(c['grip'])
        if n < -0.15: return hexc(c['lite'])         # 左上に1ドットのハイライト
        if n >  0.55: return hexc(c['shad'])
        return hexc(c['base'])
    sweep(0.0, body)

    ring = [(x, y) for y in range(H) for x in range(W)          # silhouette の外周1ドット
            if not px[x, y][3] and any(
                0 <= x+d[0] < W and 0 <= y+d[1] < H and px[x+d[0], y+d[1]][3]
                for d in ((1,0),(-1,0),(0,1),(0,-1)))]
    for (x, y) in ring: px[x, y] = OUT

    # ランクごとの飾り
    def at(t):
        x, y = bez(p0, p1, p2, t); return int(round(x)), int(round(y))
    def inked(x, y):
        return 0 <= x < W and 0 <= y < H and px[x, y][3] and px[x, y] != OUT
    if tier == 'bamboo':
        for t in (0.22, 0.36, 0.50, 0.64, 0.78):     # 竹の節
            x, y = at(t)
            for d in (-1, 0, 1):
                if inked(x+d, y): put(x+d, y, hexc(c['node']))
    if tier == 'legend':
        x, y = at(0.16)                              # 宝石
        for d in ((0,0), (1,0), (0,-1)):
            if inked(x+d[0], y+d[1]): put(x+d[0], y+d[1], hexc(c['gem']))
    if tier == 'carbon':
        for t in (0.16,):                            # 赤い巻きの締め
            x, y = at(t)
            for d in (-1, 0, 1):
                if inked(x+d, y): put(x+d, y, hexc(c['gacc']))

    b = im.getchannel('A').point(lambda v: 255 if v >= 128 else 0).getbbox()
    return im.crop(b)

made = []
for state in ('idle', 'pull'):
    for tier in ('bamboo', 'glass', 'carbon', 'legend'):
        im = draw(tier, state)
        n = f'rod_{tier}_{state}'
        im.save(n + '.png'); made.append(n)
        print(f'  {n:22s} {im.size[0]:2d}x{im.size[1]:2d}')

S, C = 6, 4
tw = max(Image.open(n+'.png').width for n in made)
th = max(Image.open(n+'.png').height for n in made)
sh = Image.new('RGBA', ((tw+3)*C*S, (th+3)*2*S), (255, 255, 255, 255))
for i, n in enumerate(made):
    im = Image.open(n+'.png')
    im = im.resize((im.width*S, im.height*S), Image.NEAREST)
    sh.alpha_composite(im, ((i % C)*(tw+3)*S, (i//C)*(th+3)*S))
sh.save('rods_preview.png')
print('rods_preview.png', sh.size)
