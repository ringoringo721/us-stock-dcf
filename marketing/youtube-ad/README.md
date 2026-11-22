# YouTube 廣東話廣告（約 30 秒）

成品：`us-stock-dcf-cantonese-ad-30s.mp4`（1920×1080、約 30 秒）

風格：真人主持人口播、生動剪接、字幕疊加、背景音樂。

## 旁白腳本（粵語）

見 `script-yue.txt`。配音預設用 Microsoft Edge TTS `zh-HK-HiuMaanNeural`（較生動嘅女聲主持）。

## 重新產生

```bash
pip install edge-tts pillow
mkdir -p /tmp/dcf-ad2

# 1) 旁白
edge-tts --voice zh-HK-HiuMaanNeural --rate="+12%" --pitch="+3Hz" \
  --file marketing/youtube-ad/script-yue.txt \
  --write-media /tmp/dcf-ad2/voice.mp3

# 2) 背景音樂 30 秒床（來自 assets/bgm-source.mp3）
ffmpeg -y -ss 8 -i marketing/youtube-ad/assets/bgm-source.mp3 -t 30 \
  -af "loudnorm=I=-18:TP=-2:LRA=9,afade=t=in:st=0:d=0.8,afade=t=out:st=28.5:d=1.5" \
  /tmp/dcf-ad2/bgm30.mp3

# 3) 畫面 + 合成
python3 marketing/youtube-ad/build_ad.py
```

## 素材

| 檔案 | 用途 |
|------|------|
| `assets/presenter-*.jpg` | 主持人畫面 |
| `assets/bgm-source.mp3` | 背景音樂來源（Pixabay Content License） |

## 場景結構

| 時段 | 畫面 | 訊息 |
|------|------|------|
| 0–1s | 主持打招呼 | 喂！ |
| 1–4s | 痛點提問 | 仲喺度靠感覺買股？ |
| 4–8s | 產品介紹 | 美股 DCF 估值雷達 |
| 8–12s | 賣點 | 一秒睇穿低估定高估 |
| 12–17s | 功能卡 | DCF / 護城河 / 智資 |
| 17–25s | CTA | 用數據投資 |
| 25–30s | 收尾 | 風險提示 |

上架 YouTube 廣告前，請自行確認平台合規披露要求，並補上你嘅實際網址／行動呼籲連結。若你有自己嘅真人拍攝素材，可替換 `assets/presenter-*.jpg` 後重跑合成。
