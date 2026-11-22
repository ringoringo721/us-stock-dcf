# YouTube 廣東話廣告（約 30 秒）

成品：`us-stock-dcf-cantonese-ad-30s.mp4`（1920×1080、約 30 秒）

風格：**對口型主持人口播**（嘴部會跟粵語旁白郁）、字幕、功能卡、背景音樂。

## 旁白腳本（粵語）

見 `script-yue.txt`。配音：Edge TTS `zh-HK-HiuMaanNeural`。

## 重新產生（完整流程）

1. 用 Edge TTS 產出旁白 → `/tmp/talking/voice.wav`（16 kHz mono）
2. 用 Wav2Lip 對 `assets/presenter-speak-02.jpg` 做唇形同步 → `assets/talking_host.mp4`
3. 跑合成：

```bash
pip install edge-tts pillow torch torchvision --index-url https://download.pytorch.org/whl/cpu
# （Wav2Lip 環境／checkpoint 見本機 build 記錄；成品 talking clip 已提交為 assets/talking_host.mp4）

mkdir -p /tmp/talking /tmp/dcf-ad2
cp marketing/youtube-ad/assets/talking_host.mp4 /tmp/talking/talking_raw.mp4
# 或 talking_body.mp4 路徑對應 compose_talking_ad.py 輸入

edge-tts --voice zh-HK-HiuMaanNeural --rate="+12%" --pitch="+3Hz" \
  --file marketing/youtube-ad/script-yue.txt \
  --write-media /tmp/dcf-ad2/voice.mp3
ffmpeg -y -i /tmp/dcf-ad2/voice.mp3 -ar 16000 -ac 1 /tmp/talking/voice.wav

ffmpeg -y -ss 8 -i marketing/youtube-ad/assets/bgm-source.mp3 -t 30 \
  -af "loudnorm=I=-18:TP=-2:LRA=9,afade=t=in:st=0:d=0.8,afade=t=out:st=28.5:d=1.5" \
  /tmp/talking/bgm30.mp3

python3 marketing/youtube-ad/compose_talking_ad.py
```

靜態版重建（無對口型）仍可用 `build_ad.py`。

## 素材

| 檔案 | 用途 |
|------|------|
| `assets/talking_host.mp4` | 對口型主持人主畫面 |
| `assets/presenter-*.jpg` | 靜態主持人／重建來源 |
| `assets/bgm-source.mp3` | 背景音樂（Pixabay Content License） |

## 說明

對口型由 Wav2Lip 驅動嘴部；全身／手勢仍來自靜態姿勢，再加輕微鏡頭搖擺。若你有真人實拍片，直接替換 `assets/talking_host.mp4` 後重跑 `compose_talking_ad.py` 即可。
