#!/usr/bin/env python3
"""
生成口播背景图：纯色底 + 居中小图（自动去白底）。

以后换素材只要改参数，不用改代码：

    python tools/make-voice-bg.py --image "C:\\path\\to\\new.png"
    python tools/make-voice-bg.py --image x.png --bg "#0d1117" --scale 45
    python tools/make-voice-bg.py --image x.png --mode flood     # 边缘泛洪（默认）
    python tools/make-voice-bg.py --image x.png --keep-white      # 不去白底

去白底两种算法：
  flood  —— 从四边向内扩散，遇到接近白色就抠掉。
           只处理「与边缘连通」的白色，因此图内部的白色
           （蕾丝、眼神光、领结）会完整保留。
  luma   —— 按亮度一刀切。简单但会误伤图内浅色区域。
"""
import argparse
import sys
from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "promo" / "assets"


def _is_bg_white(r, g, b, tol):
    """像素是否算「背景白」：够亮，且三个通道接近（无彩色）"""
    mn, mx = min(r, g, b), max(r, g, b)
    return mn >= 255 - tol and (mx - mn) <= 12


def remove_white_flood(img: Image.Image, tol: int, feather: float) -> Image.Image:
    """边缘泛洪去白底：只抠与四边连通的白色"""
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()

    # alpha=0 表示已判定为背景
    seen = bytearray(w * h)
    q = deque()

    def push(x, y):
        i = y * w + x
        if not seen[i]:
            seen[i] = 1
            q.append((x, y))

    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)

    removed = 0
    while q:
        x, y = q.popleft()
        r, g, b, _ = px[x, y]
        if not _is_bg_white(r, g, b, tol):
            continue  # 撞到非白色边界，停
        i = y * w + x
        if px[x, y][3] != 0:
            removed += 1
        px[x, y] = (r, g, b, 0)
        if x > 0:     push(x - 1, y)
        if x < w - 1: push(x + 1, y)
        if y > 0:     push(x, y - 1)
        if y < h - 1: push(x, y + 1)

    # 靠近抠除区的实心像素做羽化，消除锯齿白边
    if feather > 0 and removed:
        alpha = img.getchannel("A")
        alpha = alpha.filter(ImageFilter.GaussianBlur(feather))
        img.putalpha(alpha)
    return img


def remove_white_luma(img: Image.Image, threshold: int, feather: float) -> Image.Image:
    """按亮度一刀切（会误伤图内浅色区域）"""
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            d = ((255 - r) ** 2 + (255 - g) ** 2 + (255 - b) ** 2) ** 0.5
            if d <= threshold:
                px[x, y] = (r, g, b, 0)
            elif d < threshold + 60:
                px[x, y] = (r, g, b, int((d - threshold) / 60 * 255))
    if feather > 0:
        img.putalpha(img.getchannel("A").filter(ImageFilter.GaussianBlur(feather)))
    return img


def hex_to_rgb(s):
    s = s.lstrip("#")
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def trim_transparent(img: Image.Image) -> Image.Image:
    """裁掉四周全透明的区域，让缩放基于实际内容"""
    bbox = img.getchannel("A").getbbox()
    return img.crop(bbox) if bbox else img


def build(args) -> None:
    src = Path(args.image) if args.image else None
    if src is None:
        ASSETS.mkdir(parents=True, exist_ok=True)
        cands = sorted(p for p in ASSETS.iterdir()
                       if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")
                       and "donate" not in p.name)
        if not cands:
            sys.exit(f"{ASSETS} 下没有图片，或用 --image 指定")
        src = cands[0]
    if not src.exists():
        sys.exit(f"找不到素材: {src}")

    img = Image.open(src)
    if not args.keep_white:
        if args.mode == "flood":
            img = remove_white_flood(img, args.tol, args.feather)
        else:
            img = remove_white_luma(img, args.threshold, args.feather)
        img = trim_transparent(img)

    # 按内容高度缩放到目标百分比
    ratio = (args.height * args.scale / 100) / img.height
    if img.width * ratio > args.width * 0.85:
        ratio = (args.width * 0.85) / img.width
    img = img.resize((max(1, int(img.width * ratio)), max(1, int(img.height * ratio))),
                     Image.LANCZOS)

    canvas = Image.new("RGB", (args.width, args.height), hex_to_rgb(args.bg))
    ox = (args.width - img.width) // 2
    oy = (args.height - img.height) // 2 if args.center_y is None \
        else int(args.height * args.center_y) - img.height // 2
    canvas.paste(img, (ox, oy), img)

    out = Path(args.out) if args.out else ROOT / "promo" / "voice-bg.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, "PNG")

    print(f"已生成: {out}")
    print(f"  画布   {args.width}x{args.height}  背景 {args.bg}")
    print(f"  小图   {img.width}x{img.height}  占画面高 {img.height*100//args.height}%")
    print(f"  位置   x={ox} y={oy}")
    print(f"  去底   {'否(保留白底)' if args.keep_white else args.mode}")


def main():
    ap = argparse.ArgumentParser(description="生成口播背景图")
    ap.add_argument("--image", help="素材路径；不给则用 promo/assets/ 下第一张")
    ap.add_argument("--out", help="输出路径，默认 promo/voice-bg.png")
    ap.add_argument("--bg", default="#000000", help="背景色，默认纯黑")
    ap.add_argument("--scale", type=float, default=55, help="小图高度占画面百分比")
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--center-y", type=float, default=None,
                    help="垂直中心位置比例 0-1，默认 0.5")
    ap.add_argument("--mode", choices=["flood", "luma"], default="flood",
                    help="去白底算法，默认 flood")
    ap.add_argument("--tol", type=int, default=32, help="flood 模式容差")
    ap.add_argument("--threshold", type=int, default=28, help="luma 模式阈值")
    ap.add_argument("--feather", type=float, default=0.8, help="边缘羽化半径")
    ap.add_argument("--keep-white", action="store_true")
    a = ap.parse_args()
    build(a)


if __name__ == "__main__":
    main()