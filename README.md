# WAMKT Voice Bridge

Puente **Twilio Media Streams ↔ OpenAI Realtime API (GA `gpt-realtime`)** para
llamadas de voz con IA de baja latencia (~0.5–1s de respuesta) capaces de
realizar labores comerciales (function calling) y registrar el resultado.

## Arquitectura

```
Twilio  → POST /voice/connect      → devuelve TwiML con <Stream> WebSocket
Twilio  → WS /voice/stream         → audio g711 µ-law (pcmu) bidireccional
Bridge  → WS api.openai.com/v1/realtime?model=gpt-realtime
Bridge  → GET  WAMKT/api/voice/agent-prompt   (prompt por proyecto, cacheado)
Bridge  → POST WAMKT/api/webhooks/voice/outcome  (resultado + transcript al colgar)
```

Mejoras clave vs. versión anterior:
- Modelo **GA `gpt-realtime`** (antes `gpt-4o-realtime-preview-2024-12-17`).
- **`semantic_vad`** → turnos naturales, sin el delay fijo de 900ms.
- Voces nuevas **`marin` / `cedar`**.
- **Function calling**: `registrar_resultado`, `colgar` (extensible).
- **Captura de transcript** y webhook de resultado post-llamada.
- Pool de conexiones pre-calentadas con diagnóstico de handshake.
- Todo configurable por env (modelo, voz, VAD) sin tocar código.

## Verificar config (antes de gastar una llamada)

```bash
npm install
OPENAI_API_KEY=sk-... npm run smoke
```

Debe imprimir `✅ session.updated OK`. Si falla, dice exactamente qué rechazó
OpenAI (llave inválida, modelo inaccesible o campo malo).

## Deploy en EasyPanel

1. **Crear servicio** → *App* → *Source: GitHub* → repo `HEUSAI/wamkt-voice-bridge`, branch `main`.
2. **Build**: tipo *Dockerfile* (el repo trae uno). EasyPanel lo detecta solo.
3. **Environment** → pega al menos:
   ```
   OPENAI_API_KEY=sk-...
   WAMKT_URL=https://wamkt.notsy.com.mx
   OAI_VOICE=marin
   BRIDGE_SECRET=<un secreto largo>
   ```
4. **Domains** → asigna un dominio HTTPS (p. ej. `voice.notsy.com.mx`) al puerto `3001`.
   ⚠️ Debe ser **WSS/HTTPS público** porque Twilio abre el WebSocket contra él.
5. **Deploy**. Verifica: `curl https://<tu-dominio>/health` → `pool: "2/2"`.
   Si dice `0/2`, revisa `OPENAI_API_KEY` (logs muestran el motivo del handshake).
6. En WAMKT, apunta `VOICE_BRIDGE_URL=https://<tu-dominio>` (ver repo wamkt-notsy).

## Variables de entorno

Ver `.env.example`. Las únicas obligatorias son `OPENAI_API_KEY` y `WAMKT_URL`.
