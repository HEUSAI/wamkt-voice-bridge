# Runbook de despliegue — voicemkt.notsy.com.mx (EasyPanel / Hostinger srv1457118)

Orden importa. No saltarse el paso 0 (validación) ni el 1 (migración).

## 0. Validar config contra OpenAI (gate)
```bash
cd ~/Desktop/GITHUB/wamkt-voice-bridge
OPENAI_API_KEY=sk-... npm run smoke      # debe imprimir ✅ session.updated OK
```
Si falla aquí, NO desplegar: dice exactamente qué rechaza OpenAI (key sin acceso a
`gpt-realtime`, o un campo inválido).

## 1. Migración Supabase (WAMKT)
Aplicar `wamkt-notsy/supabase-migration-v46.sql` en el SQL editor del proyecto
Supabase de WAMKT (ref `mjncfbcilxvyqnohoqss`). Crea columnas de resultado de
llamada y la config de transferencia. Es idempotente (IF NOT EXISTS).

## 2. Push de repos
- `wamkt-voice-bridge` → push a `main` (lo consume EasyPanel).
- `wamkt-notsy` → push a `main` (Vercel redepliega; commits con autor HEUSAI).

## 3. Crear el servicio en EasyPanel
1. New → **App** → Source **GitHub** → `HEUSAI/wamkt-voice-bridge`, branch `main`.
2. Build → **Dockerfile** (auto-detectado).
3. **Environment**:
   ```
   OPENAI_API_KEY=sk-...
   WAMKT_URL=https://wamkt.notsy.com.mx
   OAI_VOICE=marin
   BRIDGE_SECRET=<secreto-largo-compartido>
   ```
4. **Domains** → `voicemkt.notsy.com.mx` → puerto interno **3001**, HTTPS (Let's Encrypt).
5. Deploy.

## 4. DNS
Crear registro **A** `voicemkt` → IP pública del VPS srv1457118 (la misma de los
otros servicios EasyPanel). Esperar propagación + cert SSL.

Verificar:
```bash
curl https://voicemkt.notsy.com.mx/health     # pool debe decir "2/2"
```
`0/2` = revisar OPENAI_API_KEY en EasyPanel (los logs dicen el motivo del handshake).

## 5. Env en WAMKT (Vercel)
```
VOICE_BRIDGE_URL=https://voicemkt.notsy.com.mx
BRIDGE_SECRET=<el-mismo-secreto-del-paso-3>
```
Redeploy de WAMKT para que tome las envs.

## 6. Config por proyecto (opcional, para tools)
En `wamkt_voice_configs` del proyecto:
- `transfer_number` = E.164 del asesor humano (para `transferir_a_humano`).
- `followup_sms` = texto/enlace que envía `enviar_info`.

## 7. Llamada real de prueba
Dashboard → Voice → test-call a tu número. Verificar en logs de EasyPanel:
`session updated OK`, `greeting done`, `lead speech`, y que al colgar llegue el
POST a `/api/webhooks/voice/outcome`. Ajustar `VAD_EAGERNESS` / `OAI_VOICE` si hace falta.

## Apagar Railway
Una vez verificado en EasyPanel, apagar el servicio viejo en Railway para no pagar doble.
