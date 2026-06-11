// Smoke test: abre un WS GA contra OpenAI Realtime, envía session.update con la
// MISMA config del bridge y verifica que el modelo la acepte (session.updated)
// sin error. Detecta llave inválida / modelo inexistente / campo rechazado
// ANTES de gastar una llamada real.
//
//   OPENAI_API_KEY=sk-... node scripts/smoke.js
require('dotenv').config()
const { WebSocket } = require('ws')

const KEY    = process.env.OPENAI_API_KEY || ''
const MODEL  = process.env.OAI_MODEL || 'gpt-realtime'
const VOICE  = process.env.OAI_VOICE || 'marin'
const VAD    = (process.env.VAD_MODE || 'semantic').toLowerCase()
const EAGER  = process.env.VAD_EAGERNESS || 'medium'
const SIL_MS = parseInt(process.env.VAD_SILENCE_MS || '500', 10)

if (!KEY) { console.error('FALTA OPENAI_API_KEY'); process.exit(1) }

const turn = VAD === 'server'
  ? { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 200, silence_duration_ms: SIL_MS }
  : { type: 'semantic_vad', eagerness: EAGER }

const url = 'wss://api.openai.com/v1/realtime?model=' + encodeURIComponent(MODEL)
console.log('Conectando a', url, '...')

const ws = new WebSocket(url, {
  headers: { Authorization: 'Bearer ' + KEY, 'OpenAI-Safety-Identifier': 'wamkt-smoke' }
})

const timeout = setTimeout(() => { console.error('❌ TIMEOUT — no hubo session.updated en 10s'); process.exit(1) }, 10000)

ws.on('unexpected-response', (_req, res) => {
  console.error('❌ Handshake rechazado: HTTP ' + res.statusCode + ' (llave inválida o modelo ' + MODEL + ' inaccesible)')
  process.exit(1)
})

ws.on('open', () => {
  console.log('✅ WS abierto. Enviando session.update...')
  ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      type: 'realtime',
      output_modalities: ['audio'],
      instructions: 'Eres un agente de prueba.',
      tools: [{ type: 'function', name: 'colgar', description: 'Termina la llamada', parameters: { type: 'object', properties: { motivo: { type: 'string' } }, required: ['motivo'] } }],
      tool_choice: 'auto',
      audio: {
        input: { format: { type: 'audio/pcmu' }, turn_detection: turn, transcription: { model: 'gpt-4o-mini-transcribe', language: 'es' } },
        output: { format: { type: 'audio/pcmu' }, voice: VOICE, speed: 1.0 }
      }
    }
  }))
})

ws.on('message', raw => {
  let e; try { e = JSON.parse(raw.toString()) } catch { return }
  if (e.type === 'session.created') console.log('• session.created')
  else if (e.type === 'session.updated') {
    clearTimeout(timeout)
    console.log('✅ session.updated OK — modelo=' + MODEL + ' voz=' + VOICE + ' vad=' + VAD)
    console.log('   La configuración del bridge es válida. Listo para llamadas reales.')
    ws.close(); process.exit(0)
  } else if (e.type === 'error') {
    clearTimeout(timeout)
    console.error('❌ OpenAI rechazó la config:', JSON.stringify(e.error, null, 2))
    ws.close(); process.exit(1)
  }
})

ws.on('error', e => { clearTimeout(timeout); console.error('❌ WS error:', e.message); process.exit(1) })
