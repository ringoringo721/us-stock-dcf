# YouTube 廣東話廣告（約 30 秒）

成品：`us-stock-dcf-cantonese-ad-30s.mp4`（1920×1080、約 30 秒）

## 旁白腳本（粵語）

見 `script-yue.txt`。配音使用 Microsoft Edge TTS `zh-HK-WanLungNeural`。

## 重新產生

```bash
# 1) 旁白
pip install edge-tts pillow
mkdir -p /tmp/dcf-ad
edge-tts --voice zh-HK-WanLungNeural --rate="+5%" \
  --file marketing/youtube-ad/script-yue.txt \
  --write-media /tmp/dcf-ad/voice.mp3

# 2) 畫面 + 合成
python3 marketing/youtube-ad/build_ad.py
```

## 場景結構

| 時段 | 畫面 | 訊息 |
|------|------|------|
| 0–3s | Hook | 仲喺度靠感覺買股？ |
| 3–8s | Brand | 美股 DCF 估值雷達 |
| 8–15s | Features | DCF / 護城河 / 智資 |
| 15–23s | CTA | 用數據投資 |
| 23–30s | Disclaimer | 投資涉及風險 |

上架 YouTube 廣告前，請自行確認平台合規披露要求，並補上你嘅實際網址／行動呼籲連結。
