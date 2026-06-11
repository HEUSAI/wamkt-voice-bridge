// Smoke test de ElevenLabs streaming TTS: verifica que la key + plan + voz generen
// audio ulaw_8000 (el formato que usa el bridge para Twilio).
//   ELEVEN_LABS_API_KEY=xi-... [ELEVEN_VOICE_ID=...] node scripts/smoke-el.js
require('dotenv').config()
const { WebSocket } = require('ws')

const KEY   = process.env.ELEVEN_LABS_API_KEY || ''
const VOICE = process.env.ELEVEN_VOICE_ID || 'ewn5JTa3lNPY8QVuZJi6'   // Ana Sofía
const MODEL = process.env.ELEVEN_MODEL || 'eleven_flash_v2_5'
if (!KEY) { console.error('FALTA ELEVEN_LABS_API_KEY'); process.exit(1) }

const url = `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE}/stream-input?model_id=${MODEL}&output_format=ulaw_8000`
console.log('Conectando a ElevenLabs (voz ' + VOICE + ')...')
const ws = new WebSocket(url, { headers: { 'xi-api-key': KEY } })
let bytes = 0
const to = setTimeout(() => { console.error('❌ TIMEOUT — sin audio en 15s'); process.exit(1) }, 15000)

ws.on('unexpected-response', (_r, res) => {
  console.error('❌ Handshake HTTP ' + res.statusCode + ' — revisa la key, que tengas plan de paga, y el voice_id')
  process.exit(1)
})
ws.on('open', () => {
  console.log('✅ WS abierto. Enviando texto de prueba...')
  ws.send(JSON.stringify({ text: ' ', voice_settings: { stability: 0.5, similarity_boost: 0.8 } }))
  ws.send(JSON.stringify({ text: 'Hola, te habla Sofía de Notsy. ¿Cómo manejan hoy las llamadas en tu negocio? ' }))
  ws.send(JSON.stringify({ text: '' }))
})
ws.on('message', raw => {
  let m; try { m = JSON.parse(raw.toString()) } catch { return }
  if (m.audio) bytes += Buffer.from(m.audio, 'base64').length
  if (m.isFinal) {
    clearTimeout(to)
    console.log('✅ ElevenLabs OK — generó ' + bytes + ' bytes de audio ulaw_8000. La voz funciona para llamadas.')
    ws.close(); process.exit(0)
  }
})
ws.on('error', e => { clearTimeout(to); console.error('❌ WS error:', e.message); process.exit(1) })
