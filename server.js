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

// ── TTS: openai (default) | elevenlabs (voz mexicana nativa) ──────────────────
const TTS       = (process.env.TTS_PROVIDER || 'openai').toLowerCase()
const EL_KEY    = process.env.ELEVEN_LABS_API_KEY || ''
const EL_VOICE  = process.env.ELEVEN_VOICE_ID || 'ewn5JTa3lNPY8QVuZJi6'   // Ana Sofía (es-MX)
const EL_MODEL  = process.env.ELEVEN_MODEL || 'eleven_flash_v2_5'         // baja latencia
let useEl    = TTS === 'elevenlabs' && !!EL_KEY
const EL_URL    = 'wss://api.elevenlabs.io/v1/text-to-speech/' + EL_VOICE +
  '/stream-input?model_id=' + EL_MODEL + '&output_format=ulaw_8000&inactivity_timeout=20&auto_mode=true'

const OAI_URL = 'wss://api.openai.com/v1/realtime?model=' + encodeURIComponent(MODEL)
// GA: SIN header OpenAI-Beta. Safety identifier recomendado.
const OAI_HEADERS = { Authorization: 'Bearer ' + KEY, 'OpenAI-Safety-Identifier': SAFETY_ID }

const VERSION = '2.6.3'  // bump para verificar deploys; visible en /health
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
  if (c && Date.now() - c.t < 1800000) return c.p
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
    // OpenAI cierra conexiones idle; reponer para no drenar el pool a 0
    setTimeout(refill, 2000)
  })
  pool.push(ws)
}

function refill() {
  const live = pool.filter(w => w.readyState <= 1).length
  for (let i = live; i < POOL_SIZE; i++) newPoolWs()
}

// Keepalive: mantener el pool lleno aunque OpenAI cierre conexiones idle
setInterval(refill, 25000)

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
  version: VERSION,
  model: MODEL,
  tts: useEl ? ('elevenlabs:' + EL_VOICE) : 'openai',
  voice: useEl ? EL_VOICE : VOICE,
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

// Diagnóstico: prueba la conexión a ElevenLabs con la llave de ESTE servidor.
app.get('/voice/el-check', (req, res) => {
  if (!EL_KEY) return res.json({ ok: false, reason: 'sin ELEVEN_LABS_API_KEY en el bridge', tts_provider: TTS })
  const ws = new WebSocket(EL_URL, { headers: { 'xi-api-key': EL_KEY } })
  let bytes = 0, done = false
  const finish = (obj) => { if (done) return; done = true; try { ws.close() } catch {}; res.json({ ...obj, voice: EL_VOICE, model: EL_MODEL, tts_provider: TTS }) }
  const t = setTimeout(() => finish({ ok: false, reason: 'timeout sin audio en 9s', bytes }), 9000)
  ws.on('open', () => {
    ws.send(JSON.stringify({ text: ' ', voice_settings: { stability: 0.5, similarity_boost: 0.8 } }))
    ws.send(JSON.stringify({ text: 'Hola desde Notsy. ' }))
    ws.send(JSON.stringify({ text: '' }))
  })
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()) } catch { return }
    if (m.audio) bytes += Buffer.from(m.audio, 'base64').length
    if (m.error || (m.message && !m.audio)) { clearTimeout(t); return finish({ ok: false, reason: 'EL: ' + String(m.message || JSON.stringify(m.error)).slice(0, 160) }) }
    if (m.isFinal) { clearTimeout(t); finish({ ok: bytes > 0, bytes }) }
  })
  ws.on('unexpected-response', (_r, r2) => { clearTimeout(t); finish({ ok: false, reason: 'handshake HTTP ' + r2.statusCode + ' (key/plan/scope)' }) })
  ws.on('error', e => { clearTimeout(t); finish({ ok: false, reason: 'ws error: ' + e.message }) })
})

// Refresca la caché del prompt al instante tras editar la config en WAMKT
app.post('/voice/reload', (req, res) => {
  const pid = req.query.pid
  if (pid) cache.delete(pid); else cache.clear()
  console.log('[bridge] cache reload pid=' + (pid || 'all'))
  res.json({ ok: true, cleared: pid || 'all' })
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
  let speakingTimer = null   // apaga botSpeaking si dejan de llegar frames de audio
  const ECHO_MS = 1200

  let greetingDone = false
  let callTimer = null
  let noSpeechTimer = null
  let leadN = 0
  let pendingHangup = false
  let outcomeSent = false
  let handoffRequested = false   // el modelo intentó transferir a un humano
  let handoffOk = false          // la transferencia en vivo se logró
  let greetingAudioSeen = false  // llegó al menos un frame de audio del bot
  let greetingWatchdog = null    // vigila que el saludo realmente suene
  let reinitTried = false        // ya se reconectó una vez por saludo mudo
  let currentPrompt = ''         // prompt vigente (para re-init en reconexión)
  let sayingGoodbye = false      // se pidió colgar; reproducir despedida antes de cerrar
  let goodbyeTimer = null        // fallback si Twilio no confirma el mark de despedida
  let inputGated = true          // ignora el audio del lead hasta que el saludo termine de sonar

  // Transcripción acumulada para el resultado post-llamada
  const transcript = []          // { role, text }
  let outcome = null             // { interes, resumen, agendar }

  function stopTimers() { clearTimeout(callTimer); clearTimeout(noSpeechTimer); clearTimeout(greetingWatchdog); clearTimeout(speakingTimer); clearTimeout(goodbyeTimer) }

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
    elStop()
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
        // En modo ElevenLabs la salida es TEXTO (la voz la genera EL); en OpenAI, audio.
        output_modalities: useEl ? ['text'] : ['audio'],
        instructions: prompt,
        tools: TOOLS,
        tool_choice: 'auto',
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            turn_detection: turnDetection(),
            transcription: { model: 'gpt-4o-mini-transcribe', language: 'es' }
          },
          ...(useEl ? {} : { output: { format: { type: 'audio/pcmu' }, voice: VOICE, speed: 1.0 } })
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
    // Descartar el audio acumulado antes del saludo (el "bueno?" del lead): si lo
    // mandáramos, OpenAI cancelaría el saludo. Empezamos a escuchar tras el saludo.
    mediaBuffer = []
    inputGated = true
    console.log('[bridge] session initialized (model=' + MODEL + ' voice=' + VOICE + ' vad=' + VAD_MODE + ')')
    // Watchdog: si en 3.5s no llegó audio del bot, la conexión (del pool) está
    // muerta; reconectamos con un WS fresco y re-saludamos. Mata el silencio.
    clearTimeout(greetingWatchdog)
    greetingWatchdog = setTimeout(() => {
      if (greetingAudioSeen || pendingHangup || handoffOk) return
      if (!reinitTried) { reinitTried = true; connectFresh() }
      else console.warn('[bridge] saludo sigue sin llegar tras reconexión')
    }, 3500)
  }

  function sendAudioToTwilio(delta) {
    if (!greetingAudioSeen) {
      greetingAudioSeen = true
      clearTimeout(greetingWatchdog)
      console.log('[bridge] primer audio del bot')
    }
    botSpeaking = true
    // Debounce: si dejan de llegar frames por 800ms, el bot ya no está hablando.
    // Evita que botSpeaking se quede pegado en true (suprimiría al lead como eco).
    clearTimeout(speakingTimer)
    speakingTimer = setTimeout(() => { botSpeaking = false; botEnd = Date.now() }, 800)
    if (delta && streamSid && tws.readyState === 1) {
      tws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: delta } }))
    }
  }

  // Fin del audio de una respuesta: marca para Twilio (greet/bye/d) y resetea estado.
  function markAudioDone() {
    botSpeaking = false
    botEnd = Date.now()
    clearTimeout(speakingTimer)
    if (streamSid && tws.readyState === 1) {
      const markName = sayingGoodbye ? 'bye' : (inputGated ? 'greet' : 'd')
      tws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: markName } }))
    }
  }

  // ── ElevenLabs streaming TTS (modo useEl): texto del modelo → voz mexicana ──
  let elWs = null, elOpen = false, elQueue = [], elFinalCb = null
  function elStart(onFinal) {
    elStop()
    elFinalCb = onFinal
    elWs = new WebSocket(EL_URL, { headers: { 'xi-api-key': EL_KEY } })
    elWs.on('open', () => {
      elOpen = true
      elWs.send(JSON.stringify({ text: ' ', voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: 1.0 } }))
      for (const o of elQueue) { try { elWs.send(JSON.stringify(o)) } catch {} }
      elQueue = []
    })
    elWs.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()) } catch { return }
      if (m.audio) sendAudioToTwilio(m.audio)
      if (m.isFinal) { const cb = elFinalCb; elFinalCb = null; if (cb) cb() }
    })
    elWs.on('error', e => console.error('[el] err:', e.message))
    elWs.on('unexpected-response', (_r, res) => console.error('[el] handshake HTTP ' + res.statusCode + ' (revisa ELEVEN_LABS_API_KEY / plan / voice_id)'))
  }
  function elSend(o) { if (elOpen && elWs?.readyState === 1) { try { elWs.send(JSON.stringify(o)) } catch {} } else elQueue.push(o) }
  function elPush(text) { if (text) elSend({ text: text }) }
  function elFlush() { elSend({ text: '' }) }   // EOS → EL emite isFinal
  function elStop() {
    try { if (elWs && elWs.readyState <= 1) { elWs.removeAllListeners(); elWs.close() } } catch {}
    elWs = null; elOpen = false; elQueue = []; elFinalCb = null
  }

  // Reconexión con WS fresco cuando una conexión del pool entregó sesión pero no
  // audio. Quitamos listeners del viejo (para que su 'close' no cierre la llamada).
  function connectFresh() {
    owsReady = false
    greetingAudioSeen = false
    greetingDone = false
    inputGated = true
    elStop()
    clearTimeout(noSpeechTimer); noSpeechTimer = null
    try { if (ows) { ows.removeAllListeners(); if (ows.readyState <= 1) ows.close() } } catch {}
    console.log('[bridge] reconectando OAI con WS fresco (saludo no llegó)')
    ows = new WebSocket(OAI_URL, { headers: OAI_HEADERS })
    setupOws()
    ows.on('open', () => { console.log('[bridge] oai reconnected'); initSession(currentPrompt) })
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
      outcome = outcome || { interes: 'bajo', resumen: args.motivo || 'cierre', agendar: outcome?.agendar || '' }
      pendingHangup = true
      sayingGoodbye = true   // generamos despedida hablada y colgamos cuando suene
      console.log('[bridge] tool colgar motivo=' + (args.motivo || ''))
      result = 'Despídete con una sola frase corta y cordial.'
    } else {
      result = 'Funcion no disponible.'
    }

    // Devolver el resultado al modelo
    if (ows?.readyState === 1) {
      ows.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: result }
      }))
      if (sayingGoodbye) {
        // Forzar una despedida hablada que CONFIRME lo acordado; NO colgamos hasta
        // que Twilio confirme que la reprodujo (mark 'bye'), con fallback por timeout.
        ows.send(JSON.stringify({ type: 'response.create', response: { instructions: 'Despídete de forma cálida, humana y cercana (tono mexicano), en una o dos frases: agradece su tiempo con sinceridad, confirma con gusto lo que quedó acordado (la cita o el siguiente paso, con su fecha y hora si la hay) y deséale un excelente día. Que se sienta una despedida amable de persona real, no un cierre seco. No hagas más preguntas.' } }))
      } else if (!pendingHangup) {
        ows.send(JSON.stringify({ type: 'response.create' }))
      }
    }
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
          sendAudioToTwilio(e.delta)   // solo modo OpenAI
          break
        case 'response.output_audio.done':
        case 'response.audio.done':
          markAudioDone()
          break

        // Modo ElevenLabs: la salida del modelo es TEXTO → se manda a EL para la voz
        case 'response.created':
          if (useEl) elStart(markAudioDone)
          break
        case 'response.output_text.delta':
        case 'response.text.delta':
          if (useEl && e.delta) elPush(e.delta)
          break
        case 'response.output_text.done':
        case 'response.text.done':
          if (useEl) elFlush()
          if (e.text) transcript.push({ role: 'assistant', text: e.text })
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
          if (sayingGoodbye) {
            // No colgar aún: esperamos el mark 'bye' de Twilio (despedida reproducida).
            // Fallback por si el mark no llega (audio muy corto / sin audio).
            clearTimeout(goodbyeTimer)
            goodbyeTimer = setTimeout(() => hangup('despedida timeout'), 7000)
            break
          }
          if (!greetingDone) {
            greetingDone = true
            console.log('[bridge] greeting done')
            // Fallback por si el mark 'greet' no regresa: abrir el oído ~1.5s después
            setTimeout(() => { if (inputGated) { inputGated = false; console.log('[bridge] ungate fallback') } }, 1500)
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
    currentPrompt = await loadPrompt(resolvedPid)
    const pooled = takeFromPool()
    if (pooled) {
      console.log('[bridge] pooled WS — instant start')
      ows = pooled
      setupOws()
      initSession(currentPrompt)
    } else {
      console.log('[bridge] fresh WS')
      ows = new WebSocket(OAI_URL, { headers: OAI_HEADERS })
      setupOws()
      ows.on('open', () => { console.log('[bridge] oai connected'); initSession(currentPrompt) })
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
      // Durante el saludo (inputGated) o reconexión ignoramos el audio del lead
      // para que su "bueno?" no interrumpa ni cancele el saludo.
      if (inputGated || !owsReady) return
      if (ows?.readyState === 1 && msg.media?.payload) {
        ows.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }))
      }
    } else if (msg.event === 'mark') {
      // Twilio confirma que terminó de reproducir el audio hasta ese mark
      if (msg.mark?.name === 'bye') {
        console.log('[bridge] despedida reproducida — colgando')
        setTimeout(() => hangup('despedida ok'), 700)  // margen para no cortar la cola
      } else if (msg.mark?.name === 'greet') {
        inputGated = false
        console.log('[bridge] saludo entregado — escuchando al lead')
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

// Preflight de ElevenLabs: si está activado pero la voz/plan/key no sirven,
// caer automáticamente a OpenAI para que las llamadas NUNCA queden mudas.
function preflightEl() {
  if (!useEl) return
  const test = new WebSocket(EL_URL, { headers: { 'xi-api-key': EL_KEY } })
  let ok = false
  const t = setTimeout(() => { if (!ok) { useEl = false; console.error('[el] preflight TIMEOUT — usando OpenAI'); try { test.close() } catch {} } }, 8000)
  test.on('open', () => { test.send(JSON.stringify({ text: ' ' })); test.send(JSON.stringify({ text: 'hola ' })); test.send(JSON.stringify({ text: '' })) })
  test.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()) } catch { return }
    if (m.audio && !ok) { ok = true; clearTimeout(t); console.log('[el] preflight OK — voz ' + EL_VOICE + ' lista'); try { test.close() } catch {} }
  })
  test.on('unexpected-response', (_r, res) => { clearTimeout(t); useEl = false; console.error('[el] preflight HTTP ' + res.statusCode + ' (key/plan/voice) — usando OpenAI') })
  test.on('error', e => { clearTimeout(t); useEl = false; console.error('[el] preflight err: ' + e.message + ' — usando OpenAI') })
}

srv.listen(PORT, () => {
  console.log('[bridge] WAMKT Voice Bridge v' + VERSION + ' on port ' + PORT + ' model=' + MODEL + ' tts=' + (useEl ? 'elevenlabs' : 'openai'))
  if (!KEY) console.warn('[bridge] FALTA OPENAI_API_KEY — el pool no se calentará y las llamadas quedarán mudas')
  for (let i = 0; i < POOL_SIZE; i++) newPoolWs()
  preflightEl()
})
