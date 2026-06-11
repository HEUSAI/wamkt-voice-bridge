require('dotenv').config()
const express = require('express')
const { WebSocketServer, WebSocket } = require('ws')
const http = require('http')

const app = express()
app.use(express.urlencoded({ extended: false }))
app.use(express.json())

// ── Config (todo configurable por env para no tocar código en EasyPanel) ──────
const PORT       = process.env.PORT || 3001
const KEY        = process.env.OPENAI_API_KEY || ''
const WAMKT      = process.env.WAMKT_URL || 'https://wamkt.notsy.com.mx'
const MODEL      = process.env.OAI_MODEL || 'gpt-realtime'           // GA model
const VOICE      = process.env.OAI_VOICE || 'marin'                  // marin | cedar | ...
const POOL_SIZE  = parseInt(process.env.POOL_SIZE || '2', 10)
const VAD_MODE   = (process.env.VAD_MODE || 'semantic').toLowerCase() // semantic | server
const VAD_EAGER  = process.env.VAD_EAGERNESS || 'medium'             // low|medium|high|auto
const VAD_SIL_MS = parseInt(process.env.VAD_SILENCE_MS || '500', 10) // server_vad
const MAX_CALL_MS = parseInt(process.env.MAX_CALL_MS || '180000', 10)
const SECRET     = process.env.BRIDGE_SECRET || ''                   // firma callbacks a WAMKT
const SAFETY_ID  = process.env.OAI_SAFETY_ID || 'wamkt-voice-bridge'

const OAI_URL = 'wss://api.openai.com/v1/realtime?model=' + encodeURIComponent(MODEL)
// GA: SIN header OpenAI-Beta. Safety identifier recomendado.
const OAI_HEADERS = { Authorization: 'Bearer ' + KEY, 'OpenAI-Safety-Identifier': SAFETY_ID }

const DEFAULT_PROMPT = 'Eres Sofia, representante de ventas de Notsy. Llamas a un prospecto para presentar el servicio. Espanol mexicano, tono amigable. Maximo 2 oraciones por respuesta.'

function turnDetection() {
  if (VAD_MODE === 'server') {
    return { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 200, silence_duration_ms: VAD_SIL_MS }
  }
  return { type: 'semantic_vad', eagerness: VAD_EAGER }
}

// ── Tools (function calling) ──────────────────────────────────────────────────
// El modelo decide cuándo invocarlas. La ejecución vive en executeTool() por
// llamada. Esto es lo que convierte "platica bonito" en "labores comerciales".
const TOOLS = [
  {
    type: 'function',
    name: 'registrar_resultado',
    description: 'Registra el resultado de la llamada. Llama esto SIEMPRE antes de colgar, en cuanto tengas claro el nivel de interes del prospecto.',
    parameters: {
      type: 'object',
      properties: {
        interes: { type: 'string', enum: ['alto', 'medio', 'bajo', 'nulo'], description: 'Nivel de interes detectado' },
        resumen: { type: 'string', description: 'Resumen de 1-2 frases de lo que paso en la llamada' },
        agendar: { type: 'string', description: 'Si el prospecto acepto una cita o callback, la fecha/hora en lenguaje natural. Vacio si no aplica.' }
      },
      required: ['interes', 'resumen']
    }
  },
  {
    type: 'function',
    name: 'transferir_a_humano',
    description: 'Transfiere la llamada a un asesor humano. Usalo cuando el prospecto pide hablar con una persona, o cuando esta muy interesado y listo para cerrar. Avisa con voz ("te comunico con un asesor") ANTES de llamar esta funcion.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    type: 'function',
    name: 'enviar_info',
    description: 'Envia al prospecto la informacion/enlace de seguimiento por mensaje de texto (SMS). Usalo cuando pida que le mandes detalles, precios o el enlace. Confirma con voz que ya lo enviaste.',
    parameters: {
      type: 'object',
      properties: { mensaje: { type: 'string', description: 'Opcional. Texto a enviar; si lo dejas vacio se usa el mensaje configurado del proyecto.' } },
      required: []
    }
  },
  {
    type: 'function',
    name: 'colgar',
    description: 'Termina la llamada cordialmente: cuando el prospecto no tiene interes, pide no ser contactado, o la conversacion ya concluyo. Despidete con voz ANTES de llamar esta funcion.',
    parameters: {
      type: 'object',
      properties: { motivo: { type: 'string', description: 'Motivo breve del cierre' } },
      required: ['motivo']
    }
  }
]

// ── Prompt cache ──────────────────────────────────────────────────────────────
const cache = new Map()
const inflight = new Map()

async function loadPrompt(pid) {
  const c = cache.get(pid)
  if (c && Date.now() - c.t < 300000) return c.p
  if (inflight.has(pid)) return inflight.get(pid)
  const prom = (async () => {
    try {
      const r = await fetch(WAMKT + '/api/voice/agent-prompt?project_id=' + encodeURIComponent(pid), {
        signal: AbortSignal.timeout(8000)
      })
      if (r.ok) {
        const d = await r.json()
        if (d.prompt) {
          cache.set(pid, { p: d.prompt, t: Date.now() })
          console.log('[bridge] prompt loaded pid=' + pid + ' len=' + d.prompt.length)
          return d.prompt
        }
      }
    } catch (e) { console.warn('[bridge] prompt failed:', e.message) }
    console.log('[bridge] using default prompt')
    return DEFAULT_PROMPT
  })()
  inflight.set(pid, prom)
  prom.finally(() => inflight.delete(pid))
  return prom
}

// ── OpenAI WS pool — conexiones pre-calentadas para matar la latencia de handshake
const pool = []

function newPoolWs() {
  if (!KEY) { console.warn('[pool] sin OPENAI_API_KEY — no se calienta'); return }
  const ws = new WebSocket(OAI_URL, { headers: OAI_HEADERS })
  ws._ok = false
  ws.on('open', () => {
    ws._ok = true
    console.log('[pool] ready ' + pool.filter(w => w._ok).length + '/' + POOL_SIZE)
  })
  ws.on('unexpected-response', (_req, res) => {
    console.error('[pool] handshake rechazado HTTP ' + res.statusCode + ' (revisa OPENAI_API_KEY / modelo ' + MODEL + ')')
  })
  ws.on('error', e => {
    console.warn('[pool] err:', e.message)
    const i = pool.indexOf(ws); if (i !== -1) pool.splice(i, 1)
    setTimeout(refill, 2000)
  })
  ws.on('close', () => {
    const i = pool.indexOf(ws); if (i !== -1) pool.splice(i, 1)
  })
  pool.push(ws)
}

function refill() {
  const live = pool.filter(w => w.readyState <= 1).length
  for (let i = live; i < POOL_SIZE; i++) newPoolWs()
}

function takeFromPool() {
  const i = pool.findIndex(w => w._ok && w.readyState === 1)
  if (i < 0) return null
  const ws = pool.splice(i, 1)[0]
  console.log('[pool] took one, remaining=' + pool.length)
  setTimeout(refill, 500)
  return ws
}

app.get('/health', (_, res) => res.json({
  ok: true,
  service: 'wamkt-voice-bridge',
  model: MODEL,
  voice: VOICE,
  vad: VAD_MODE,
  pool: pool.filter(w => w._ok).length + '/' + POOL_SIZE
}))

app.post('/voice/connect', (req, res) => {
  const pid = req.query.project_id || ''
  const cid = req.query.campaign_id || ''
  const host = req.headers.host || req.hostname
  const wsUrl = 'wss://' + host + '/voice/stream?pid=' + encodeURIComponent(pid)
  if (pid) loadPrompt(pid).catch(() => {})
  refill()
  const twiml = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response><Connect><Stream url="' + wsUrl + '">' +
    '<Parameter name="project_id" value="' + pid + '"/>' +
    '<Parameter name="campaign_id" value="' + cid + '"/>' +
    '</Stream></Connect></Response>'
  res.type('text/xml').send(twiml)
})

const srv = http.createServer(app)
const wss = new WebSocketServer({ server: srv, path: '/voice/stream' })

wss.on('connection', (tws, req) => {
  let pid = ''
  try { pid = new URL('http://x' + req.url).searchParams.get('pid') || '' } catch {}

  let ows = null
  let streamSid = null
  let callSid = ''
  let campaignId = ''
  let mediaBuffer = []
  let owsReady = false

  let botSpeaking = true
  let botEnd = 0
  const ECHO_MS = 1200

  let greetingDone = false
  let callTimer = null
  let noSpeechTimer = null
  let leadN = 0
  let pendingHangup = false
  let outcomeSent = false
  let handoffRequested = false   // el modelo intentó transferir a un humano
  let handoffOk = false          // la transferencia en vivo se logró

  // Transcripción acumulada para el resultado post-llamada
  const transcript = []          // { role, text }
  let outcome = null             // { interes, resumen, agendar }

  function stopTimers() { clearTimeout(callTimer); clearTimeout(noSpeechTimer) }

  async function sendOutcome(reason) {
    if (outcomeSent) return
    outcomeSent = true
    try {
      await fetch(WAMKT + '/api/webhooks/voice/outcome', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(SECRET ? { 'x-bridge-secret': SECRET } : {}) },
        body: JSON.stringify({
          call_sid: callSid, project_id: pid, campaign_id: campaignId,
          reason, outcome, transcript, ended_at: new Date().toISOString(),
          handoff_requested: handoffRequested, handoff_ok: handoffOk
        }),
        signal: AbortSignal.timeout(5000)
      })
      console.log('[bridge] outcome enviado sid=' + callSid + ' interes=' + (outcome?.interes || '-'))
    } catch (e) { console.warn('[bridge] outcome falló:', e.message) }
  }

  function hangup(why) {
    console.log('[bridge] hangup:', why)
    stopTimers()
    sendOutcome(why)
    try { if (ows?.readyState === 1) ows.close() } catch {}
    try { if (tws.readyState === 1) tws.close() } catch {}
  }

  function flushBuffer() {
    if (!owsReady || !mediaBuffer.length) return
    for (const payload of mediaBuffer) {
      ows.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }))
    }
    console.log('[bridge] flushed ' + mediaBuffer.length + ' buffered packets')
    mediaBuffer = []
  }

  function initSession(prompt) {
    // session.update — esquema GA: audio anidado, sin temperature, tools incluidas
    ows.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        instructions: prompt,
        tools: TOOLS,
        tool_choice: 'auto',
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            turn_detection: turnDetection(),
            transcription: { model: 'gpt-4o-mini-transcribe', language: 'es' }
          },
          output: { format: { type: 'audio/pcmu' }, voice: VOICE, speed: 1.0 }
        }
      }
    }))
    ows.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[Empieza la llamada]' }] }
    }))
    ows.send(JSON.stringify({ type: 'response.create' }))
    callTimer = setTimeout(() => hangup('max call'), MAX_CALL_MS)
    owsReady = true
    flushBuffer()
    console.log('[bridge] session initialized (model=' + MODEL + ' voice=' + VOICE + ' vad=' + VAD_MODE + ')')
  }

  function sendAudioToTwilio(delta) {
    botSpeaking = true
    if (delta && streamSid && tws.readyState === 1) {
      tws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: delta } }))
    }
  }

  async function callDispatcher(tool, args) {
    try {
      const r = await fetch(WAMKT + '/api/voice/tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(SECRET ? { 'x-bridge-secret': SECRET } : {}) },
        body: JSON.stringify({ tool, args, project_id: pid, call_sid: callSid, campaign_id: campaignId }),
        signal: AbortSignal.timeout(8000)
      })
      const d = await r.json().catch(() => ({}))
      return { ok: !!d.ok, speak: d.speak || 'Hecho.' }
    } catch (e) {
      console.warn('[bridge] dispatcher falló:', e.message)
      return { ok: false, speak: 'No pude completar esa accion ahora.' }
    }
  }

  async function executeTool(name, callId, args) {
    let result = 'ok'
    let transferred = false

    if (name === 'registrar_resultado') {
      outcome = { interes: args.interes || 'medio', resumen: args.resumen || '', agendar: args.agendar || '' }
      console.log('[bridge] tool registrar_resultado interes=' + outcome.interes)
      result = 'Resultado registrado.'
    } else if (name === 'enviar_info') {
      console.log('[bridge] tool enviar_info')
      result = (await callDispatcher('enviar_info', args)).speak
    } else if (name === 'transferir_a_humano') {
      console.log('[bridge] tool transferir_a_humano')
      handoffRequested = true
      const resp = await callDispatcher('transferir_a_humano', args)
      result = resp.speak
      if (resp.ok) {
        // Enlace en vivo logrado: Twilio toma la llamada
        handoffOk = true
        transferred = true
        outcome = { interes: 'alto', resumen: 'Transferido a asesor', agendar: outcome?.agendar || '' }
      } else {
        // No se logró enlazar: la llamada sigue, el modelo da el mensaje de respaldo
        // y al cerrar se notifica al equipo (handoff_requested && !handoff_ok)
        console.log('[bridge] handoff no enlazado -> se avisará al equipo al cerrar')
      }
    } else if (name === 'colgar') {
      outcome = outcome || { interes: 'bajo', resumen: args.motivo || 'cierre', agendar: '' }
      pendingHangup = true
      console.log('[bridge] tool colgar motivo=' + (args.motivo || ''))
      result = 'Llamada finalizada.'
    } else {
      result = 'Funcion no disponible.'
    }

    // Devolver el resultado al modelo
    if (ows?.readyState === 1) {
      ows.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: result }
      }))
      if (!pendingHangup) ows.send(JSON.stringify({ type: 'response.create' }))
    }
    // Si pidió colgar, dar gracia para que termine de hablar y cerrar
    if (pendingHangup) setTimeout(() => hangup('tool:colgar'), 3500)
    // Si transfirió, Twilio toma el control de la llamada; cerramos OAI tras la despedida
    if (transferred) setTimeout(() => { sendOutcome('tool:transferir'); try { if (ows?.readyState === 1) ows.close() } catch {} }, 4000)
  }

  function setupOws() {
    ows.on('message', raw => {
      let e
      try { e = JSON.parse(raw.toString()) } catch { return }

      switch (e.type) {
        // Audio del modelo → Twilio (GA usa response.output_audio.*, preview usaba response.audio.*)
        case 'response.output_audio.delta':
        case 'response.audio.delta':
          sendAudioToTwilio(e.delta)
          break
        case 'response.output_audio.done':
        case 'response.audio.done':
          botEnd = Date.now()
          if (streamSid && tws.readyState === 1) {
            tws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'd' } }))
          }
          break

        // Transcripción del bot
        case 'response.output_audio_transcript.done':
          if (e.transcript) transcript.push({ role: 'assistant', text: e.transcript })
          break
        // Transcripción del lead
        case 'conversation.item.input_audio_transcription.completed':
          if (e.transcript) transcript.push({ role: 'user', text: e.transcript })
          break

        // Function calling
        case 'response.function_call_arguments.done': {
          let args = {}
          try { args = JSON.parse(e.arguments || '{}') } catch {}
          executeTool(e.name, e.call_id, args)
          break
        }

        case 'response.done':
          botSpeaking = false
          botEnd = Date.now()
          if (pendingHangup) { hangup('tool:colgar:done'); break }
          if (!greetingDone) {
            greetingDone = true
            console.log('[bridge] greeting done')
            noSpeechTimer = setTimeout(() => { if (leadN === 0) hangup('no lead speech') }, 22000)
          }
          break

        case 'input_audio_buffer.speech_started': {
          const age = Date.now() - botEnd
          if (botSpeaking || age < ECHO_MS) {
            console.log('[bridge] echo suppressed bot=' + botSpeaking + ' age=' + age)
            break
          }
          leadN++
          clearTimeout(noSpeechTimer); noSpeechTimer = null
          console.log('[bridge] lead speech #' + leadN)
          break
        }
        case 'input_audio_buffer.speech_stopped':
          console.log('[bridge] lead stopped #' + leadN)
          break

        case 'session.created':
          console.log('[bridge] oai session created')
          break
        case 'session.updated':
          console.log('[bridge] oai session updated OK')
          break
        case 'error':
          console.error('[bridge] OAI ERROR:', JSON.stringify(e.error))
          break
      }
    })

    ows.on('close', code => {
      stopTimers()
      console.log('[bridge] oai closed code=' + code)
      sendOutcome('oai closed')
      try { if (tws.readyState === 1) tws.close() } catch {}
    })

    ows.on('error', e => console.error('[bridge] oai err:', e.message))
  }

  async function start(resolvedPid) {
    const prompt = await loadPrompt(resolvedPid)
    const pooled = takeFromPool()
    if (pooled) {
      console.log('[bridge] pooled WS — instant start')
      ows = pooled
      setupOws()
      initSession(prompt)
    } else {
      console.log('[bridge] fresh WS')
      ows = new WebSocket(OAI_URL, { headers: OAI_HEADERS })
      setupOws()
      ows.on('open', () => { console.log('[bridge] oai connected'); initSession(prompt) })
    }
  }

  tws.on('message', raw => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }

    if (msg.event === 'connected') {
      console.log('[bridge] twilio connected')
    } else if (msg.event === 'start') {
      streamSid = msg.start?.streamSid || ''
      callSid = msg.start?.callSid || ''
      const cp = msg.start?.customParameters || {}
      const rPid = cp['project_id'] || pid
      campaignId = cp['campaign_id'] || ''
      console.log('[bridge] stream started sid=' + streamSid + ' call=' + callSid + ' pid=' + rPid)
      start(rPid)
    } else if (msg.event === 'media') {
      if (!owsReady) {
        if (msg.media?.payload) mediaBuffer.push(msg.media.payload)
      } else if (ows?.readyState === 1 && msg.media?.payload) {
        ows.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }))
      }
    } else if (msg.event === 'stop') {
      hangup('stream stopped')
    }
  })

  tws.on('close', () => {
    stopTimers()
    console.log('[bridge] twilio closed')
    sendOutcome('twilio closed')
    try { if (ows?.readyState === 1) ows.close() } catch {}
  })

  tws.on('error', e => console.error('[bridge] twilio err:', e.message))
})

srv.listen(PORT, () => {
  console.log('[bridge] WAMKT Voice Bridge on port ' + PORT + ' model=' + MODEL)
  if (!KEY) console.warn('[bridge] FALTA OPENAI_API_KEY — el pool no se calentará y las llamadas quedarán mudas')
  for (let i = 0; i < POOL_SIZE; i++) newPoolWs()
})
