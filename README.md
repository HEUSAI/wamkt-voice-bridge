# WAMKT Voice Bridge

Bridges Twilio Media Streams <-> OpenAI Realtime API for low-latency AI voice calls.

## Deploy on Railway

1. Connect this repo to Railway
2. Set env var: `OPENAI_API_KEY`
3. Set env var: `WAMKT_URL=https://wamkt.notsy.com.mx`
4. Deploy — Railway auto-detects Node.js

## How it works

Twilio calls → `/voice/connect` → returns TwiML with Media Stream WebSocket URL
Twilio opens WebSocket → bridge forwards audio to OpenAI Realtime → streams response audio back
Result: ~1-2 second response latency vs ~10 seconds with HTTP approach
