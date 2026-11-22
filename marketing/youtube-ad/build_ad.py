#!/usr/bin/env python3
"""Build a lively ~30s Cantonese presenter YouTube ad for 美股 DCF 估值雷達."""

from __future__ import annotations

import math
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
WORK = Path("/tmp/dcf-ad2")
W, H = 1920, 1080
FPS = 30

ACCENT = (56, 189, 248)
GREEN = (74, 222, 128)
GOLD = (251, 191, 36)
WHITE = (255, 255, 255)
MUTED = (210, 220, 230)

FONT = "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"


def font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT, size=size)


def load_presenter(name: str) -> Image.Image:
    img = Image.open(ASSETS / name).convert("RGB")
    # Cover-crop to 16:9 1920x1080
    src_w, src_h = img.size
    target = W / H
    if src_w / src_h > target:
        new_w = int(src_h * target)
        left = (src_w - new_w) // 2
        img = img.crop((left, 0, left + new_w, src_h))
    else:
        new_h = int(src_w / target)
        top = max(0, (src_h - new_h) // 3)  # bias upward to keep face
        img = img.crop((0, top, src_w, top + new_h))
    return img.resize((W, H), Image.Resampling.LANCZOS)


def vignette(img: Image.Image, strength: float = 0.45) -> Image.Image:
    overlay = Image.new("RGB", (W, H), (0, 0, 0))
    # Radial falloff from center
    mask = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(mask)
    cx, cy = W // 2, H // 2
    max_r = int(math.hypot(cx, cy))
    for i in range(48, 0, -1):
        r = int(max_r * i / 48)
        # Outer rings darker (higher mask => more black overlay)
        alpha = int(255 * strength * ((48 - i) / 48) ** 1.35)
        md.ellipse([cx - r, cy - r, cx + r, cy + r], fill=alpha)
    mask = mask.filter(ImageFilter.GaussianBlur(28))
    return Image.composite(overlay, img, mask)


def draw_caption(
    base: Image.Image,
    text: str,
    *,
    y: int = 820,
    size: int = 64,
    fill=WHITE,
    accent_bar: bool = True,
) -> Image.Image:
    img = base.copy()
    # Dark gradient banner for readability
    banner = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(banner)
    for i in range(280):
        a = int(190 * (i / 280) ** 0.7)
        bd.rectangle([0, H - 280 + i, W, H - 279 + i], fill=(4, 10, 18, a))
    img = Image.alpha_composite(img.convert("RGBA"), banner).convert("RGB")
    d = ImageDraw.Draw(img)
    f = font(size)
    # Soft wrap
    max_w = 1680
    lines: list[str] = []
    if d.textlength(text, font=f) <= max_w:
        lines = [text]
    else:
        cur = ""
        for ch in text:
            trial = cur + ch
            if d.textlength(trial, font=f) <= max_w:
                cur = trial
            else:
                lines.append(cur)
                cur = ch
        if cur:
            lines.append(cur)
    total_h = len(lines) * (size + 14)
    ty = y - total_h // 2
    if accent_bar:
        d.rectangle([80, ty - 18, 92, ty + total_h + 8], fill=ACCENT)
    for i, line in enumerate(lines):
        # Shadow
        d.text((118, ty + i * (size + 14) + 3), line, font=f, fill=(0, 0, 0))
        d.text((116, ty + i * (size + 14)), line, font=f, fill=fill)
    return img


def draw_brand_chip(img: Image.Image, x: int = 70, y: int = 60) -> Image.Image:
    out = img.copy()
    d = ImageDraw.Draw(out)
    label = "美股 DCF 估值雷達"
    f = font(34)
    tw = d.textlength(label, font=f)
    d.rounded_rectangle([x, y, x + tw + 48, y + 64], radius=18, fill=(8, 16, 28), outline=ACCENT, width=3)
    d.text((x + 24, y + 12), label, font=f, fill=ACCENT)
    return out


def feature_cards(base: Image.Image) -> Image.Image:
    img = base.copy().convert("RGBA")
    cards = [
        ("DCF 估值", "低估／高估一眼清", GREEN),
        ("巴菲特護城河", "十大維度診斷", GOLD),
        ("智資動態", "掌握機構信號", ACCENT),
    ]
    card_w, card_h = 420, 180
    gap = 36
    total = 3 * card_w + 2 * gap
    x0 = (W - total) // 2
    y0 = 120
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for i, (title, body, color) in enumerate(cards):
        x = x0 + i * (card_w + gap)
        od.rounded_rectangle(
            [x, y0, x + card_w, y0 + card_h],
            radius=24,
            fill=(8, 14, 24, 230),
            outline=(*color, 255),
            width=4,
        )
        od.text((x + 28, y0 + 34), title, font=font(40), fill=color)
        od.text((x + 28, y0 + 100), body, font=font(30), fill=WHITE)
    return Image.alpha_composite(img, overlay).convert("RGB")


def cta_button(base: Image.Image, text: str = "即刻打開美股 DCF 估值雷達") -> Image.Image:
    img = base.copy()
    d = ImageDraw.Draw(img)
    f = font(44)
    tw = d.textlength(text, font=f)
    bw, bh = tw + 90, 92
    bx, by = (W - bw) // 2, 760
    # Glow
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.rounded_rectangle([bx - 10, by - 10, bx + bw + 10, by + bh + 10], radius=26, fill=(*ACCENT, 70))
    img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=22, fill=ACCENT)
    d.text((bx + 45, by + 20), text, font=f, fill=(0, 0, 0))
    return img


def end_card() -> Image.Image:
    img = Image.new("RGB", (W, H), (5, 10, 18))
    px = img.load()
    for y in range(H):
        for x in range(0, W, 4):
            t = y / H
            c = (
                int(5 + 20 * (1 - t)),
                int(10 + 30 * (1 - t)),
                int(18 + 45 * (1 - t)),
            )
            for dx in range(4):
                if x + dx < W:
                    px[x + dx, y] = c
    d = ImageDraw.Draw(img)
    # Soft orb
    orb = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(orb)
    for r, a in ((420, 50), (300, 70), (180, 90)):
        od.ellipse([W // 2 - r, 220 - r // 4, W // 2 + r, 520 + r // 4], fill=(56, 189, 248, a))
    img = Image.alpha_composite(img.convert("RGBA"), orb).convert("RGB")
    d = ImageDraw.Draw(img)
    brand = "美股 DCF 估值雷達"
    tw = d.textlength(brand, font=font(86))
    d.text(((W - tw) / 2, 360), brand, font=font(86), fill=WHITE)
    d.rectangle([W // 2 - 180, 470, W // 2 + 180, 476], fill=ACCENT)
    tip = "用數據投資，唔好靠運氣"
    tw = d.textlength(tip, font=font(44))
    d.text(((W - tw) / 2, 520), tip, font=font(44), fill=ACCENT)
    note = "投資涉及風險，請自行判斷"
    tw = d.textlength(note, font=font(34))
    d.text(((W - tw) / 2, 620), note, font=font(34), fill=MUTED)
    return img


def write_scenes() -> list[tuple[Path, float]]:
    WORK.mkdir(parents=True, exist_ok=True)
    p_smile = vignette(load_presenter("presenter-speak-01.jpg"))
    p_talk = vignette(load_presenter("presenter-speak-02.jpg"))
    p_point = vignette(load_presenter("presenter-point-03.jpg"))
    p_lively = vignette(load_presenter("presenter-lively-04.jpg"))

    scenes: list[tuple[Image.Image, str, float]] = [
        # Hook
        (draw_caption(draw_brand_chip(p_lively), "喂！", y=760, size=120), "01.png", 1.15),
        (draw_caption(draw_brand_chip(p_talk), "你仲喺度靠感覺買股呀？", y=820, size=58), "02.png", 2.65),
        # Brand intro
        (
            draw_caption(
                draw_brand_chip(p_smile),
                "等我介紹吓——美股 DCF 估值雷達！",
                y=820,
                size=52,
                fill=ACCENT,
            ),
            "03.png",
            3.5,
        ),
        # Value
        (
            draw_caption(draw_brand_chip(p_talk), "一秒睇穿低估定高估 · 美股港股都齊全", y=820, size=50),
            "04.png",
            4.45,
        ),
        # Features with cards
        (
            draw_caption(
                feature_cards(draw_brand_chip(p_point)),
                "DCF 估值、護城河、智資動態，一站搞掂",
                y=860,
                size=46,
            ),
            "05.png",
            5.0,
        ),
        # Energy CTA line
        (
            draw_caption(draw_brand_chip(p_lively), "用數據投資，唔好靠運氣啦！", y=820, size=58, fill=GREEN),
            "06.png",
            3.05,
        ),
        # CTA button
        (
            cta_button(draw_caption(draw_brand_chip(p_smile), "開始你嘅價值投資之路", y=680, size=44, accent_bar=False)),
            "07.png",
            4.75,
        ),
        # End
        (end_card(), "08.png", 5.45),
    ]

    out: list[tuple[Path, float]] = []
    for img, name, dur in scenes:
        # Slight punchier contrast for ad feel
        img = ImageEnhance.Contrast(img).enhance(1.08)
        img = ImageEnhance.Color(img).enhance(1.05)
        path = WORK / name
        img.save(path, "PNG", optimize=True)
        out.append((path, dur))
    return out


def build_silent_video(scenes: list[tuple[Path, float]], out_path: Path) -> None:
    # Per-scene zoompan for lively motion, then concat
    parts: list[Path] = []
    for i, (path, dur) in enumerate(scenes):
        frames = max(1, int(round(dur * FPS)))
        part = WORK / f"part_{i:02d}.mp4"
        # Alternate zoom direction for energy
        if i % 2 == 0:
            z = f"min(zoom+0.0009,1.12)"
            x = "iw/2-(iw/zoom/2)"
            y = "ih/2-(ih/zoom/2)-20"
        else:
            z = f"if(eq(on,1),1.10,max(zoom-0.0008,1.0))"
            x = "iw/2-(iw/zoom/2)+10"
            y = "ih/2-(ih/zoom/2)"
        vf = (
            f"scale=8000:-1,zoompan=z='{z}':x='{x}':y='{y}':d={frames}:s={W}x{H}:fps={FPS},"
            f"format=yuv420p"
        )
        subprocess.run(
            [
                "ffmpeg", "-y", "-loop", "1", "-i", str(path),
                "-vf", vf, "-frames:v", str(frames),
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
                str(part),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        parts.append(part)

    concat = WORK / "parts.txt"
    concat.write_text("".join(f"file '{p}'\n" for p in parts), encoding="utf-8")
    subprocess.run(
        [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
            "-movflags", "+faststart",
            str(out_path),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def mix_audio(voice: Path, bgm: Path, out_audio: Path) -> None:
    # Duck BGM under voice; pad/trim to 30s
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(voice),
            "-i", str(bgm),
            "-filter_complex",
            "[0:a]aformat=channel_layouts=stereo,loudnorm=I=-14:TP=-1.5:LRA=8,apad=pad_dur=30[voice];"
            "[1:a]aformat=channel_layouts=stereo,volume=0.28,"
            "afade=t=in:st=0:d=0.6,afade=t=out:st=28.8:d=1.2[bg];"
            "[voice][bg]amix=inputs=2:duration=first:dropout_transition=0,"
            "atrim=0:30,asetpts=PTS-STARTPTS,loudnorm=I=-15:TP=-1.5:LRA=9[aout]",
            "-map", "[aout]",
            "-c:a", "aac", "-b:a", "192k",
            str(out_audio),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def main() -> None:
    voice = WORK / "voice.mp3"
    bgm = WORK / "bgm30.mp3"
    if not voice.exists():
        raise SystemExit(
            f"Missing voice track: {voice}\n"
            "Generate it first with edge-tts (see marketing/youtube-ad/README.md)."
        )
    if not bgm.exists():
        # Build from checked-in source if needed
        src = ASSETS / "bgm-source.mp3"
        if not src.exists():
            raise SystemExit(f"Missing BGM: {bgm} and {src}")
        subprocess.run(
            [
                "ffmpeg", "-y", "-ss", "8", "-i", str(src), "-t", "30",
                "-af", "loudnorm=I=-18:TP=-2:LRA=9,afade=t=in:st=0:d=0.8,afade=t=out:st=28.5:d=1.5",
                str(bgm),
            ],
            check=True,
        )
    if not (ROOT / "script-yue.txt").is_file():
        raise SystemExit(f"Missing canonical script: {ROOT / 'script-yue.txt'}")
    for name in (
        "presenter-speak-01.jpg",
        "presenter-speak-02.jpg",
        "presenter-point-03.jpg",
        "presenter-lively-04.jpg",
    ):
        if not (ASSETS / name).is_file():
            raise SystemExit(f"Missing presenter asset: {ASSETS / name}")

    scenes = write_scenes()
    # Keep a few compressed JPEG stills for PR preview
    keep = {"01.png", "03.png", "05.png", "07.png", "08.png"}
    for path, _ in scenes:
        if path.name in keep:
            Image.open(path).convert("RGB").save(
                ROOT / f"preview_{path.stem}.jpg", quality=85, optimize=True
            )

    silent = WORK / "video_silent.mp4"
    build_silent_video(scenes, silent)

    # Ensure exactly 30s video
    video30 = WORK / "video_30.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(silent),
            "-vf", "tpad=stop_mode=clone:stop_duration=30",
            "-t", "30",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
            str(video30),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    mixed = WORK / "mixed.m4a"
    mix_audio(voice, bgm, mixed)

    out = ROOT / "us-stock-dcf-cantonese-ad-30s.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(video30),
            "-i", str(mixed),
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            "-movflags", "+faststart",
            str(out),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    print(f"Wrote {out}")
    subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration,size",
            "-of", "default=noprint_wrappers=1",
            str(out),
        ],
        check=True,
    )


if __name__ == "__main__":
    main()
