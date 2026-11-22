#!/usr/bin/env python3
"""Compose the final 30s ad from a lip-synced talking-head clip."""

from __future__ import annotations

import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
WORK = Path("/tmp/talking")
W, H = 1920, 1080
FONT = "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"
ACCENT = (56, 189, 248)
GREEN = (74, 222, 128)
GOLD = (251, 191, 36)
WHITE = (255, 255, 255)


def font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT, size=size)


def write_ass(path: Path) -> None:
    # Timings from edge-tts VTT for current script-yue.txt
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


def feature_overlay_png(path: Path) -> None:
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cards = [
        ("DCF 估值", "低估／高估一眼清", GREEN),
        ("巴菲特護城河", "十大維度診斷", GOLD),
        ("智資動態", "掌握機構信號", ACCENT),
    ]
    card_w, card_h = 400, 150
    gap = 28
    total = 3 * card_w + 2 * gap
    x0 = (W - total) // 2
    y0 = 70
    for i, (title, body, color) in enumerate(cards):
        x = x0 + i * (card_w + gap)
        d.rounded_rectangle(
            [x, y0, x + card_w, y0 + card_h],
            radius=20,
            fill=(8, 14, 24, 220),
            outline=(*color, 255),
            width=3,
        )
        d.text((x + 22, y0 + 28), title, font=font(34), fill=color)
        d.text((x + 22, y0 + 84), body, font=font(26), fill=WHITE)
    img.save(path)


def end_card_png(path: Path) -> None:
    img = Image.new("RGB", (W, H), (5, 10, 18))
    d = ImageDraw.Draw(img)
    brand = "美股 DCF 估值雷達"
    tw = d.textlength(brand, font=font(78))
    d.text(((W - tw) / 2, 380), brand, font=font(78), fill=WHITE)
    d.rectangle([W // 2 - 160, 485, W // 2 + 160, 491], fill=ACCENT)
    tip = "用數據投資，唔好靠運氣"
    tw = d.textlength(tip, font=font(42))
    d.text(((W - tw) / 2, 530), tip, font=font(42), fill=ACCENT)
    note = "投資涉及風險，請自行判斷"
    tw = d.textlength(note, font=font(34))
    d.text(((W - tw) / 2, 620), note, font=font(34), fill=(180, 190, 200))
    img.save(path)


def main() -> None:
    WORK.mkdir(parents=True, exist_ok=True)

    talking = WORK / "talking_body.mp4"
    if not talking.exists():
        talking = WORK / "talking_raw.mp4"
    if not talking.exists() and (ASSETS / "talking_host.mp4").exists():
        talking = ASSETS / "talking_host.mp4"
    # Prefer the original Edge TTS render (higher sample rate), not the 16 kHz
    # mono dump that Wav2Lip consumes.
    voice_candidates = [
        WORK / "voice.mp3",
        Path("/tmp/dcf-ad2/voice.mp3"),
        ROOT / "assets" / "voice.mp3",
        WORK / "voice.wav",
    ]
    voice = next((p for p in voice_candidates if p.exists()), None)
    bgm_src = ASSETS / "bgm-source.mp3"
    if not talking.exists():
        raise SystemExit(f"Missing talking clip under {WORK} or {ASSETS / 'talking_host.mp4'}")
    if voice is None:
        raise SystemExit(
            "Missing voice track. Provide /tmp/talking/voice.mp3 (Edge TTS) "
            "or /tmp/talking/voice.wav."
        )

    ass = WORK / "captions.ass"
    write_ass(ass)
    cards = WORK / "feature_cards.png"
    feature_overlay_png(cards)
    end = WORK / "end_card.png"
    end_card_png(end)

    bgm30 = WORK / "bgm30.mp3"
    subprocess.run(
        [
            "ffmpeg", "-y", "-ss", "8", "-i", str(bgm_src), "-t", "30",
            "-af", "loudnorm=I=-18:TP=-2:LRA=9,afade=t=in:st=0:d=0.6,afade=t=out:st=28.5:d=1.4",
            str(bgm30),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    # Talking plate with slight sway + captions; feature cards mid-way; pad to 30s
    plated = WORK / "talking_plated.mp4"
    # Escape ASS path for ffmpeg filter
    ass_esc = str(ass).replace("\\", "/").replace(":", "\\:")
    cards_esc = str(cards).replace("\\", "/").replace(":", "\\:")
    # Accept either square lip-sync plate or already-composited 16:9 host video.
    probe = subprocess.check_output(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=p=0:s=x",
            str(talking),
        ],
        text=True,
    ).strip()
    width_s, height_s = probe.split("x")
    width, height = int(width_s), int(height_s)
    aspect = width / max(height, 1)
    if width == 1920 and height == 1080:
        base_vf = "setsar=1,rotate=0.008*sin(2*PI*t/2.8):c=0x050A12:ow=1920:oh=1080"
    elif aspect >= 1.5:
        # Landscape / 16:9-ish: fit inside 1920x1080 without squashing.
        base_vf = (
            "setsar=1,"
            "scale=1920:1080:force_original_aspect_ratio=decrease,"
            "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x050A12,"
            "rotate=0.008*sin(2*PI*t/2.8):c=0x050A12:ow=1920:oh=1080"
        )
    else:
        # Square / portrait lip-sync plate: letterbox, keep aspect.
        base_vf = (
            "setsar=1,"
            "scale=980:980:force_original_aspect_ratio=decrease,"
            "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x050A12,"
            "rotate=0.012*sin(2*PI*t/2.6):c=0x050A12:ow=1920:oh=1080"
        )
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(talking),
            "-i", str(cards),
            "-filter_complex",
            f"[0:v]{base_vf}[base];"
            f"[base][1:v]overlay=0:0:enable='between(t,11.8,16.9)'[ov];"
            f"[ov]ass='{ass_esc}'[vout]",
            "-map", "[vout]", "-an",
            "-t", "27.9",
            "-c:v", "libx264", "-crf", "18", "-preset", "fast",
            "-pix_fmt", "yuv420p",
            str(plated),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    # Append end card (~2.1s) to reach 30s
    end_vid = WORK / "end.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-loop", "1", "-i", str(end),
            "-t", "2.2", "-r", "25",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
            str(end_vid),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    concat = WORK / "concat.txt"
    concat.write_text(
        f"file '{plated}'\nfile '{end_vid}'\n",
        encoding="utf-8",
    )
    silentish = WORK / "video_concat.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
            "-t", "30",
            str(silentish),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    # Mix high-quality VO + BGM at 48 kHz stereo (never leave the mix at 16 kHz).
    mixed = WORK / "final_audio.m4a"
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(voice),
            "-i", str(bgm30),
            "-filter_complex",
            "[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
            "loudnorm=I=-14:TP=-1.5:LRA=8,apad=pad_dur=30[voice];"
            "[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.26,"
            "afade=t=in:st=0:d=0.5,afade=t=out:st=28.7:d=1.2[bg];"
            "[voice][bg]amix=inputs=2:duration=first:dropout_transition=0,"
            "atrim=0:30,asetpts=PTS-STARTPTS,loudnorm=I=-15:TP=-1.5:LRA=9[aout]",
            "-map", "[aout]", "-ar", "48000", "-c:a", "aac", "-b:a", "192k",
            str(mixed),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    out = ROOT / "us-stock-dcf-cantonese-ad-30s.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(silentish),
            "-i", str(mixed),
            "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k",
            "-t", "30",
            "-movflags", "+faststart",
            str(out),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    # Preview stills
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(out),
            "-vf", "select=eq(n\\,40)+eq(n\\,200)+eq(n\\,360)+eq(n\\,700)",
            "-vsync", "vfr",
            str(WORK / "preview_%02d.png"),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for i, name in enumerate(["01", "03", "05", "07"], start=1):
        src = WORK / f"preview_{i:02d}.png"
        if src.exists():
            Image.open(src).convert("RGB").save(ROOT / f"preview_{name}.jpg", quality=85)

    # Keep talking clip asset for rebuild documentation
    dest = ASSETS / "talking_host.mp4"
    dest.write_bytes(talking.read_bytes())

    print(f"Wrote {out}")
    subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration,size",
         "-of", "default=noprint_wrappers=1", str(out)],
        check=True,
    )


if __name__ == "__main__":
    main()
