#!/usr/bin/env python3
"""Build a 30s AI-styled Cantonese ad with gesture cuts + lip sync + BGM."""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
WORK = Path("/tmp/talking/ai")
W, H = 1920, 1080
FPS = 25
FONT = "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"

ACCENT = (56, 189, 248)
GREEN = (74, 222, 128)
GOLD = (251, 191, 36)
WHITE = (255, 255, 255)
CYAN = (34, 211, 238)

# Face crop fractions used when generating Wav2Lip inputs (must match build).
FACE_CROPS = {
    "ai-host-gesture-open": (0.30, 0.00, 0.70, 0.62),
    "ai-host-point-right": (0.22, 0.00, 0.62, 0.62),
    "ai-host-explain": (0.30, 0.00, 0.70, 0.62),
}

# Script-timed gesture cuts (seconds).
SEGMENTS = [
    ("ai-host-gesture-open", 0.0, 3.88),
    ("ai-host-explain", 3.88, 11.85),
    ("ai-host-point-right", 11.85, 16.84),
    ("ai-host-gesture-open", 16.84, 24.70),
    ("ai-host-explain", 24.70, 27.90),
]


def font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT, size=size)


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def fit_canvas(img: Image.Image) -> Image.Image:
    src_w, src_h = img.size
    scale = max(W / src_w, H / src_h)
    nw, nh = int(src_w * scale), int(src_h * scale)
    scaled = img.resize((nw, nh), Image.Resampling.LANCZOS)
    left = (nw - W) // 2
    top = max(0, (nh - H) // 6)
    return scaled.crop((left, top, left + W, top + H)), scale, left, top


def composite_pose_segment(stem: str, start: float, end: float, out: Path) -> Path:
    """Paste lip-synced face onto body for [start,end) only."""
    body = Image.open(ASSETS / f"{stem}.jpg").convert("RGB")
    canvas0, scale, left, top = fit_canvas(body)
    l, t, r, b = FACE_CROPS[stem]
    bw, bh = body.size
    box = (int(bw * l), int(bh * t), int(bw * r), int(bh * b))
    bx0 = int(box[0] * scale - left)
    by0 = int(box[1] * scale - top)
    bx1 = int(box[2] * scale - left)
    by1 = int(box[3] * scale - top)

    lips = WORK / f"lips_{stem}.mp4"
    seg_dir = WORK / f"segframes_{out.stem}"
    if seg_dir.exists():
        for old in seg_dir.glob("*"):
            old.unlink()
    else:
        seg_dir.mkdir(parents=True, exist_ok=True)
    run(
        [
            "ffmpeg", "-y", "-ss", f"{start:.3f}", "-i", str(lips),
            "-t", f"{max(0.04, end - start):.3f}",
            str(seg_dir / "f_%05d.png"),
        ]
    )
    frames = sorted(seg_dir.glob("f_*.png"))
    if not frames:
        raise SystemExit(f"No frames for {stem} {start}-{end}")

    # Soft mask once
    sample = Image.open(frames[0]).convert("RGB").resize((bx1 - bx0, by1 - by0), Image.Resampling.LANCZOS)
    mask = Image.new("L", sample.size, 0)
    md = ImageDraw.Draw(mask)
    md.ellipse(
        [
            int(sample.size[0] * 0.05),
            int(sample.size[1] * 0.03),
            int(sample.size[0] * 0.95),
            int(sample.size[1] * 0.97),
        ],
        fill=255,
    )
    mask = mask.filter(ImageFilter.GaussianBlur(7))

    out_dir = WORK / f"comp_{out.stem}"
    if out_dir.exists():
        for old in out_dir.glob("*"):
            old.unlink()
    else:
        out_dir.mkdir(parents=True, exist_ok=True)

    for i, fp in enumerate(frames):
        canvas = canvas0.copy()
        face = Image.open(fp).convert("RGB").resize((bx1 - bx0, by1 - by0), Image.Resampling.LANCZOS)
        canvas.paste(face, (bx0, by0), mask)
        bob = int(4 * np.sin(2 * np.pi * (start * FPS + i) / 36))
        if bob:
            shifted = Image.new("RGB", canvas.size, (4, 10, 18))
            shifted.paste(canvas, (0, bob))
            canvas = shifted
        canvas.save(out_dir / f"f_{i:05d}.png")

    run(
        [
            "ffmpeg", "-y", "-framerate", str(FPS), "-i", str(out_dir / "f_%05d.png"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17", "-preset", "fast",
            str(out),
        ]
    )
    return out


def hud_overlay(path: Path) -> None:
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Corner brackets
    for x0, y0 in ((40, 40), (W - 220, 40), (40, H - 160), (W - 220, H - 160)):
        d.line([(x0, y0 + 40), (x0, y0), (x0 + 40, y0)], fill=(*CYAN, 160), width=3)
        d.line([(x0 + 140, y0), (x0 + 180, y0), (x0 + 180, y0 + 40)], fill=(*CYAN, 160), width=3)
        d.line([(x0, y0 + 100), (x0, y0 + 140), (x0 + 40, y0 + 140)], fill=(*CYAN, 160), width=3)
        d.line([(x0 + 140, y0 + 140), (x0 + 180, y0 + 140), (x0 + 180, y0 + 100)], fill=(*CYAN, 160), width=3)
    # Top AI chip
    d.rounded_rectangle([70, 48, 430, 100], radius=14, fill=(8, 20, 34, 200), outline=(*ACCENT, 220), width=2)
    d.text((92, 58), "AI VALUATION RADAR", font=font(28), fill=ACCENT)
    # Side pulse bars
    for i in range(6):
        y = 180 + i * 70
        d.rectangle([48, y, 58, y + 36], fill=(*CYAN, 90 + i * 20))
    img.save(path)


def feature_cards(path: Path) -> None:
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cards = [
        ("DCF 估值", "低估／高估一眼清", GREEN),
        ("巴菲特護城河", "十大維度診斷", GOLD),
        ("智資動態", "掌握機構信號", ACCENT),
    ]
    card_w, card_h, gap = 400, 150, 28
    total = 3 * card_w + 2 * gap
    x0 = (W - total) // 2
    y0 = 70
    for i, (title, body, color) in enumerate(cards):
        x = x0 + i * (card_w + gap)
        d.rounded_rectangle(
            [x, y0, x + card_w, y0 + card_h],
            radius=20,
            fill=(6, 16, 28, 230),
            outline=(*color, 255),
            width=3,
        )
        d.text((x + 22, y0 + 28), title, font=font(34), fill=color)
        d.text((x + 22, y0 + 84), body, font=font(26), fill=WHITE)
    img.save(path)


def write_ass(path: Path) -> None:
    events = [
        (0.10, 1.22, "喂！"),
        (1.17, 3.88, "你仲喺度靠感覺買股呀？"),
        (3.88, 7.38, "等我介紹吓——美股 DCF 估值雷達！"),
        (7.38, 11.85, "一秒睇穿低估定高估，美股港股都齊全"),
        (11.85, 16.84, "DCF 估值、巴菲特護城河、智資動態，一站搞掂"),
        (16.84, 19.93, "用數據投資，唔好靠運氣啦！"),
        (19.93, 24.70, "即刻打開美股 DCF 估值雷達，開始價值投資"),
        (24.70, 27.94, "投資涉及風險，請自行判斷"),
    ]

    def ts(sec: float) -> str:
        h = int(sec // 3600)
        m = int((sec % 3600) // 60)
        s = sec % 60
        return f"{h}:{m:02d}:{s:05.2f}"

    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "PlayResX: 1920",
        "PlayResY: 1080",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Default,WenQuanYi Micro Hei,56,&H00FFFFFF,&H000000FF,&H00400000,&H90000000,"
        "-1,0,0,0,100,100,0,0,1,3,0,2,80,80,70,1",
        "Style: Brand,WenQuanYi Micro Hei,34,&H00F8BD38,&H000000FF,&H00400000,&H90000000,"
        "-1,0,0,0,100,100,0,0,1,2,0,7,60,60,40,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        f"Dialogue: 0,{ts(0)},{ts(27.9)},Brand,,0,0,0,,美股 DCF 估值雷達",
    ]
    for a, b, text in events:
        lines.append(f"Dialogue: 0,{ts(a)},{ts(b)},Default,,0,0,0,,{text}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def end_card(path: Path) -> None:
    bg = Image.open(ASSETS / "ai-bg-plate.jpg").convert("RGB")
    canvas, _, _, _ = fit_canvas(bg)
    # Darken a bit for title readability
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 110))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), overlay).convert("RGB")
    d = ImageDraw.Draw(canvas)
    brand = "美股 DCF 估值雷達"
    tw = d.textlength(brand, font=font(78))
    d.text(((W - tw) / 2, 380), brand, font=font(78), fill=WHITE)
    d.rectangle([W // 2 - 160, 485, W // 2 + 160, 491], fill=ACCENT)
    tip = "AI 驅動 · 用數據投資"
    tw = d.textlength(tip, font=font(42))
    d.text(((W - tw) / 2, 530), tip, font=font(42), fill=ACCENT)
    note = "投資涉及風險，請自行判斷"
    tw = d.textlength(note, font=font(34))
    d.text(((W - tw) / 2, 620), note, font=font(34), fill=(180, 190, 200))
    canvas.save(path)


def main() -> None:
    WORK.mkdir(parents=True, exist_ok=True)

    parts = []
    for idx, (stem, start, end) in enumerate(SEGMENTS):
        part = WORK / f"seg_{idx:02d}.mp4"
        print(f"composite segment {idx}: {stem} {start:.2f}-{end:.2f}")
        composite_pose_segment(stem, start, end, part)
        parts.append(part)

    # Hard-cut concat keeps segment clocks aligned with captions/voice.
    # (xfade would overlap cuts and desync lip-sync by ~fade*(n-1) seconds.)
    gesture_vid = WORK / "gesture_timeline.mp4"
    if len(parts) == 1:
        run(["ffmpeg", "-y", "-i", str(parts[0]), "-c:v", "libx264",
             "-pix_fmt", "yuv420p", "-crf", "17", str(gesture_vid)])
    else:
        glist = WORK / "gesture_concat.txt"
        glist.write_text("".join(f"file '{p}'\n" for p in parts), encoding="utf-8")
        run(
            [
                "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(glist),
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17",
                str(gesture_vid),
            ]
        )

    hud = WORK / "hud.png"
    cards = WORK / "cards.png"
    ass = WORK / "captions.ass"
    endp = WORK / "end.png"
    hud_overlay(hud)
    feature_cards(cards)
    write_ass(ass)
    end_card(endp)

    ass_esc = str(ass).replace("\\", "/").replace(":", "\\:")
    plated = WORK / "plated.mp4"
    run(
        [
            "ffmpeg", "-y",
            "-i", str(gesture_vid),
            "-i", str(hud),
            "-i", str(cards),
            "-filter_complex",
            f"[0:v]setsar=1[base];"
            f"[base][1:v]overlay=0:0[h];"
            f"[h][2:v]overlay=0:0:enable='between(t,11.8,16.9)'[ov];"
            f"[ov]ass='{ass_esc}'[vout]",
            "-map", "[vout]", "-an", "-t", "27.9",
            "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-pix_fmt", "yuv420p",
            str(plated),
        ]
    )

    end_vid = WORK / "end.mp4"
    run(
        [
            "ffmpeg", "-y", "-loop", "1", "-i", str(endp),
            "-t", "2.2", "-r", str(FPS),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
            str(end_vid),
        ]
    )
    concat = WORK / "concat.txt"
    concat.write_text(f"file '{plated}'\nfile '{end_vid}'\n", encoding="utf-8")
    video = WORK / "video30.mp4"
    run(
        [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-t", "30",
            str(video),
        ]
    )

    # Audio: prefer HQ Edge TTS + BGM
    voice = next(
        (
            p
            for p in (
                Path("/tmp/talking/voice.mp3"),
                Path("/tmp/dcf-ad2/voice.mp3"),
                WORK / "voice.mp3",
                Path("/tmp/talking/voice.wav"),
            )
            if p.exists()
        ),
        None,
    )
    if voice is None:
        raise SystemExit("Missing voice track")
    bgm30 = WORK / "bgm30.mp3"
    run(
        [
            "ffmpeg", "-y", "-ss", "8", "-i", str(ASSETS / "bgm-source.mp3"), "-t", "30",
            "-af", "loudnorm=I=-18:TP=-2:LRA=9,afade=t=in:st=0:d=0.5,afade=t=out:st=28.5:d=1.4",
            str(bgm30),
        ]
    )
    mixed = WORK / "mixed.m4a"
    run(
        [
            "ffmpeg", "-y", "-i", str(voice), "-i", str(bgm30),
            "-filter_complex",
            "[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
            "loudnorm=I=-14:TP=-1.5:LRA=8,apad=pad_dur=30[voice];"
            "[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.30,"
            "afade=t=in:st=0:d=0.4,afade=t=out:st=28.7:d=1.2[bg];"
            "[voice][bg]amix=inputs=2:duration=first:dropout_transition=0,"
            "atrim=0:30,asetpts=PTS-STARTPTS,loudnorm=I=-15:TP=-1.5:LRA=9[aout]",
            "-map", "[aout]", "-ar", "48000", "-c:a", "aac", "-b:a", "192k",
            str(mixed),
        ]
    )

    out = ROOT / "us-stock-dcf-cantonese-ad-30s.mp4"
    run(
        [
            "ffmpeg", "-y", "-i", str(video), "-i", str(mixed),
            "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-t", "30", "-movflags", "+faststart",
            str(out),
        ]
    )

    # Save first gesture segment as representative talking-host preview asset
    (ASSETS / "talking_host.mp4").write_bytes(parts[0].read_bytes())

    # Previews
    run(
        [
            "ffmpeg", "-y", "-i", str(out),
            "-vf", "select=eq(n\\,30)+eq(n\\,150)+eq(n\\,320)+eq(n\\,500)+eq(n\\,700)",
            "-vsync", "vfr",
            str(WORK / "prev_%02d.png"),
        ]
    )
    for i, name in enumerate(["01", "03", "05", "07", "08"], start=1):
        src = WORK / f"prev_{i:02d}.png"
        if src.exists():
            Image.open(src).convert("RGB").save(ROOT / f"preview_{name}.jpg", quality=85)

    print(f"Wrote {out}")
    subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration,size",
         "-of", "default=noprint_wrappers=1", str(out)],
        check=True,
    )


if __name__ == "__main__":
    main()
