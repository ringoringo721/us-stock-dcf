# YouTube 廣東話廣告（約 30 秒）

成品：`us-stock-dcf-cantonese-ad-30s.mp4`（1920×1080、約 30 秒）

風格：
- AI 全息／先進感背景
- 多姿勢肢體語言切鏡（開掌、雙手解釋、指向儀表）
- 對口型粵語旁白
- 立體聲背景音樂 + HUD／功能卡

## 旁白腳本

見 `script-yue.txt`（Edge TTS `zh-HK-HiuMaanNeural`）。

## 重建

```bash
# 1) 旁白
mkdir -p /tmp/talking /tmp/dcf-ad2
edge-tts --voice zh-HK-HiuMaanNeural --rate="+12%" --pitch="+3Hz" \
  --file marketing/youtube-ad/script-yue.txt \
  --write-media /tmp/dcf-ad2/voice.mp3
cp /tmp/dcf-ad2/voice.mp3 /tmp/talking/voice.mp3
ffmpeg -y -i /tmp/talking/voice.mp3 -ar 16000 -ac 1 /tmp/talking/voice.wav

# 2) 對每個 AI host 姿勢做 Wav2Lip（需本機 Wav2Lip + checkpoints）
#    輸出：/tmp/talking/ai/lips_ai-host-*.mp4

# 3) 合成肢體切鏡 + HUD + BGM
python3 marketing/youtube-ad/build_ai_talking_ad.py
```

舊版靜態／單姿勢合成仍可用 `build_ad.py` / `compose_talking_ad.py`。

## 素材

| 檔案 | 用途 |
|------|------|
| `assets/ai-host-*.jpg` | AI 風主持人姿勢 |
| `assets/ai-bg-plate.jpg` | 收尾 AI 背景 |
| `assets/bgm-source.mp3` | 背景音樂 |
| `assets/talking_host.mp4` | 對口型預覽片段 |

上架前請補上實際網址，並確認廣告合規披露。
