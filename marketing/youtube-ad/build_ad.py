#!/usr/bin/env python3
"""Build a ~30s Cantonese YouTube ad for 美股 DCF 估值雷達."""

from __future__ import annotations

import math
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
WORK = Path("/tmp/dcf-ad")
W, H = 1920, 1080
FPS = 30

BG = (5, 8, 14)
ACCENT = (56, 189, 248)
GREEN = (74, 222, 128)
GOLD = (251, 191, 36)
TEXT = (250, 250, 250)
MUTED = (163, 163, 163)
CARD = (18, 22, 30)

FONT_PATH = "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"


def font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_PATH, size=size)


def draw_bg(base_shift: float = 0.0) -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    px = img.load()
    for y in range(H):
        t = y / H
        r = int(5 + 18 * t)
        g = int(8 + 28 * t)
        b = int(14 + 42 * t)
        for x in range(W):
            wave = 0.5 + 0.5 * math.sin((x / W) * math.pi * 2 + base_shift)
            px[x, y] = (
                min(255, int(r + 10 * wave * (1 - t))),
                min(255, int(g + 18 * wave * (1 - t))),
                min(255, int(b + 30 * wave * (1 - t))),
            )
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    # Soft spotlight behind brand
    for i, alpha in enumerate((55, 35, 18)):
        r = 420 - i * 70
        d.ellipse(
            [W // 2 - r, 140 - i * 20, W // 2 + r, 520 + i * 20],
            fill=(56, 189, 248, alpha),
        )
    # Diagonal scan lines for a radar feel
    for i in range(-2, 8):
        y0 = 180 + i * 120
        d.line([(0, y0), (W, y0 + 80)], fill=(56, 189, 248, 18), width=2)
    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    return img


def center_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    y: int,
    fnt: ImageFont.FreeTypeFont,
    fill=TEXT,
    max_width: int = 1600,
) -> int:
    words = list(text)
    # Prefer wrapping on punctuation / spaces for CJK lines provided as wholes.
    lines = []
    if draw.textlength(text, font=fnt) <= max_width:
        lines = [text]
    else:
        # Character wrap
        cur = ""
        for ch in words:
            trial = cur + ch
            if draw.textlength(trial, font=fnt) <= max_width:
                cur = trial
            else:
                if cur:
                    lines.append(cur)
                cur = ch
        if cur:
            lines.append(cur)
    for i, line in enumerate(lines):
        tw = draw.textlength(line, font=fnt)
        draw.text(((W - tw) / 2, y + i * (fnt.size + 18)), line, font=fnt, fill=fill)
    return len(lines)


def scene_hook() -> Image.Image:
    img = draw_bg(0.2)
    d = ImageDraw.Draw(img)
    center_text(d, "仲喺度靠感覺買股？", 430, font(84), TEXT)
    sub = "情緒買賣，未必夠穩陣"
    tw = d.textlength(sub, font=font(40))
    d.text(((W - tw) / 2, 560), sub, font=font(40), fill=MUTED)
    return img


def scene_brand() -> Image.Image:
    img = draw_bg(0.8)
    d = ImageDraw.Draw(img)
    brand = "美股 DCF 估值雷達"
    tw = d.textlength(brand, font=font(92))
    d.text(((W - tw) / 2, 360), brand, font=font(92), fill=TEXT)
    # Accent underline
    d.rectangle([W // 2 - 220, 480, W // 2 + 220, 486], fill=ACCENT)
    line = "一秒睇穿低估定高估"
    tw = d.textlength(line, font=font(52))
    d.text(((W - tw) / 2, 520), line, font=font(52), fill=ACCENT)
    tag = "估值篩選  ·  公司財報  ·  趨勢分析"
    tw = d.textlength(tag, font=font(34))
    d.text(((W - tw) / 2, 620), tag, font=font(34), fill=MUTED)
    return img


def scene_features() -> Image.Image:
    img = draw_bg(1.4)
    d = ImageDraw.Draw(img)
    title = "美股 + 港股，一站搞掂"
    tw = d.textlength(title, font=font(64))
    d.text(((W - tw) / 2, 220), title, font=font(64), fill=TEXT)

    cards = [
        ("DCF 估值", "指示 / 槓桿 DCF\n低估高估一眼清", GREEN),
        ("巴菲特護城河", "十大維度診斷\n睇清競爭優勢", GOLD),
        ("智資動態", "機構動向追蹤\n掌握市場信號", ACCENT),
    ]
    card_w, card_h = 480, 320
    gap = 60
    total = 3 * card_w + 2 * gap
    x0 = (W - total) // 2
    y0 = 360
    for i, (h, body, color) in enumerate(cards):
        x = x0 + i * (card_w + gap)
        # Card background
        overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)
        od.rounded_rectangle(
            [x, y0, x + card_w, y0 + card_h],
            radius=28,
            fill=(18, 22, 30, 220),
            outline=(*color, 200),
            width=3,
        )
        img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
        d = ImageDraw.Draw(img)
        d.text((x + 36, y0 + 40), h, font=font(42), fill=color)
        by = y0 + 120
        for line in body.split("\n"):
            d.text((x + 36, by), line, font=font(34), fill=TEXT)
            by += 56
    return img


def scene_cta() -> Image.Image:
    img = draw_bg(2.0)
    d = ImageDraw.Draw(img)
    line1 = "用數據投資，唔好靠運氣"
    tw = d.textlength(line1, font=font(68))
    d.text(((W - tw) / 2, 340), line1, font=font(68), fill=TEXT)

    # CTA button
    cta = "即刻打開美股 DCF 估值雷達"
    f = font(44)
    tw = d.textlength(cta, font=f)
    bw, bh = tw + 100, 96
    bx, by = (W - bw) // 2, 480
    d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=20, fill=ACCENT)
    d.text((bx + 50, by + 22), cta, font=f, fill=(0, 0, 0))

    tip = "開始你嘅價值投資之路"
    tw = d.textlength(tip, font=font(36))
    d.text(((W - tw) / 2, 620), tip, font=font(36), fill=MUTED)
    return img


def scene_disclaimer() -> Image.Image:
    img = draw_bg(2.4)
    d = ImageDraw.Draw(img)
    brand = "美股 DCF 估值雷達"
    tw = d.textlength(brand, font=font(72))
    d.text(((W - tw) / 2, 400), brand, font=font(72), fill=TEXT)
    note = "投資涉及風險，請自行判斷"
    tw = d.textlength(note, font=font(40))
    d.text(((W - tw) / 2, 520), note, font=font(40), fill=MUTED)
    return img


def write_scenes() -> list[tuple[Path, float]]:
    WORK.mkdir(parents=True, exist_ok=True)
    scenes = [
        (scene_hook(), "01_hook.png", 2.7),
        (scene_brand(), "02_brand.png", 5.0),
        (scene_features(), "03_features.png", 6.8),
        (scene_cta(), "04_cta.png", 8.0),
        (scene_disclaimer(), "05_disclaimer.png", 7.5),  # end hold pads to 30s
    ]
    out = []
    for img, name, dur in scenes:
        path = WORK / name
        img.save(path, "PNG")
        out.append((path, dur))
    return out


def build_video(scenes: list[tuple[Path, float]], voice: Path, out_mp4: Path) -> None:
    # Build concat list with durations
    list_file = WORK / "scenes.txt"
    lines = []
    for path, dur in scenes:
        lines.append(f"file '{path}'")
        lines.append(f"duration {dur:.3f}")
    # Last frame must be repeated for concat demuxer
    lines.append(f"file '{scenes[-1][0]}'")
    list_file.write_text("\n".join(lines) + "\n", encoding="utf-8")

    silent_video = WORK / "video_silent.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0", "-i", str(list_file),
            "-vf", f"fps={FPS},format=yuv420p",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            str(silent_video),
        ],
        check=True,
    )

    # Soft bed: very quiet filtered noise under voice (keeps ad from feeling dry)
    bed = WORK / "bed.wav"
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.015:sample_rate=44100",
            "-t", "30",
            "-af", "lowpass=f=400,volume=0.35",
            str(bed),
        ],
        check=True,
    )

    # Mix voice + bed, pad/trim to 30s
    mixed = WORK / "mixed.m4a"
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(voice),
            "-i", str(bed),
            "-filter_complex",
            "[0:a]loudnorm=I=-16:TP=-1.5:LRA=11,apad=pad_dur=30[a0];"
            "[1:a]volume=0.25,atrim=0:30,apad=pad_dur=30[a1];"
            "[a0][a1]amix=inputs=2:duration=first:dropout_transition=0,"
            "atrim=0:30,asetpts=PTS-STARTPTS[aout]",
            "-map", "[aout]",
            "-c:a", "aac", "-b:a", "192k",
            str(mixed),
        ],
        check=True,
    )

    # Ensure video is exactly 30s
    padded = WORK / "video_30.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(silent_video),
            "-vf", "tpad=stop_mode=clone:stop_duration=30",
            "-t", "30",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            str(padded),
        ],
        check=True,
    )

    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(padded),
            "-i", str(mixed),
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            "-movflags", "+faststart",
            str(out_mp4),
        ],
        check=True,
    )


def main() -> None:
    voice = WORK / "voice.mp3"
    if not voice.exists():
        raise SystemExit(
            f"Missing voice track: {voice}\n"
            "Generate it first with edge-tts (see marketing/youtube-ad/README.md)."
        )
    if not (ROOT / "script-yue.txt").is_file():
        raise SystemExit(f"Missing canonical script: {ROOT / 'script-yue.txt'}")

    scenes = write_scenes()
    out = ROOT / "us-stock-dcf-cantonese-ad-30s.mp4"
    build_video(scenes, voice, out)

    # Refresh checked-in scene stills next to the mp4
    for path, _ in scenes:
        Image.open(path).save(ROOT / path.name)

    print(f"Wrote {out}")
    subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration,size",
         "-of", "default=noprint_wrappers=1", str(out)],
        check=True,
    )


if __name__ == "__main__":
    main()
