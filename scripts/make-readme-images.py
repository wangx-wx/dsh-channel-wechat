"""Crop and downscale the published screenshots for the README and the OG card.

The originals in docs/assets stay untouched (docs/assets/README.md records that
the landing page publishes them as-is). This writes smaller copies under
docs/assets/readme/ because a README embedding the 1.5 MB original would
download it on every visit, and a 1200x630 social card next to them.
"""

from PIL import Image
import os

SRC = "docs/assets"
OUT = "docs/assets/readme"
os.makedirs(OUT, exist_ok=True)


def make(name, box, width, out_name, quality=86):
    im = Image.open(os.path.join(SRC, name)).convert("RGB")
    c = im.crop(box)
    h = round(c.height * width / c.width)
    c = c.resize((width, h), Image.LANCZOS)
    dst = os.path.join(OUT, out_name)
    c.save(dst, "JPEG", quality=quality, optimize=True, progressive=True)
    print(f"{dst}  {c.size[0]}x{c.size[1]}  {os.path.getsize(dst)} bytes")


# WeChat chat: the opening exchange plus the working-directory question.
make("wechat-chat.jpg", (0, 0, 1200, 1620), 620, "wechat-chat.jpg")

# Approval card: message -> card -> reply -> acknowledgement.
make("approval-card.jpg", (0, 40, 1200, 2169), 620, "approval-card.jpg")

# Plugin page is a wide desktop shot; keep it wider than the phones.
im = Image.open(os.path.join(SRC, "plugin-page.png")).convert("RGB")
w = 1500
h = round(im.height * w / im.width)
im = im.resize((w, h), Image.LANCZOS)
dst = os.path.join(OUT, "plugin-page.jpg")
im.save(dst, "JPEG", quality=88, optimize=True, progressive=True)
print(f"{dst}  {im.size[0]}x{im.size[1]}  {os.path.getsize(dst)} bytes")


def og_image():
    """1200x630 social card: the plugin page's content column, cropped to 1.91:1.

    The full screenshot is a mostly empty 2560x1351 canvas with the plugin card
    centred, so the card is what gets cropped to rather than the whole frame.
    """
    im = Image.open(os.path.join(SRC, "plugin-page.png")).convert("RGB")
    left, right = 780, 1790
    crop_h = round((right - left) * 630 / 1200)
    top = 120
    im = im.crop((left, top, right, top + crop_h)).resize((1200, 630), Image.LANCZOS)
    dst = os.path.join(SRC, "og-image.jpg")
    im.save(dst, "JPEG", quality=88, optimize=True, progressive=True)
    print(f"{dst}  {im.size[0]}x{im.size[1]}  {os.path.getsize(dst)} bytes")


og_image()
