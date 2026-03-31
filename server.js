require('dotenv').config()
const express = require('express')
const { WebSocketServer, WebSocket } = require('ws')
const http = require('http')

const app = express()
app.use(express.urlencoded({ extended: false }))
app.use(express.json())

const PORT = process.env.PORT || 3001
const KEY = process.env.OPENAI_API_KEY || ''
const WAMKT = process.env.WAMKT_URL || 'https://wamkt.notsy.com.mx'
const OAI_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17'
const DEFAULT_PROMPT = 'Eres Sofia, representante de ventas de Notsy. Llamas a un prospecto para presentar el servicio. Espanol mexicano, tono amigable. Maximo 2 oraciones por respuesta.'

// Prompt cache
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

// OpenAI WS pool — 2 pre-warmed connections to eliminate handshake latency
const POOL_SIZE = 2
const pool = []

function newPoolWs() {
  if (!KEY) return
  const ws = new WebSocket(OAI_URL, {
    headers: { Authorization: 'Bearer ' + KEY, 'OpenAI-Beta': 'realtime=v1' }
  })
  ws._ok = false
  ws.on('open', () => {
    ws._ok = true
    console.log('[pool] ready ' + pool.filter(w => w._ok).length + '/' + POOL_SIZE)
  })
  ws.on('error', e => {
    console.warn('[pool] err:', e.message)
    const i = pool.indexOf(ws)
    if (i !== -1) pool.splice(i, 1)
    setTimeout(refill, 2000)
  })
  ws.on('close', () => {
    const i = pool.indexOf(ws)
    if (i !== -1) pool.splice(i, 1)
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
  pool: pool.filter(w => w._ok).length + '/' + POOL_SIZE
}))

app.post('/voice/connect', (req, res) => {
  const pid = req.query.project_id || ''
  const host = req.headers.host || req.hostname
  const wsUrl = 'wss://' + host + '/voice/stream?pid=' + encodeURIComponent(pid)
  if (pid) loadPrompt(pid).catch(() => {})
  refill()
  const twiml = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response><Connect><Stream url="' + wsUrl + '">' +
    '<Parameter name="project_id" value="' + pid + '"/>' +
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
  let mediaBuffer = []  // buffer audio that arrives before OAI session is ready
  let owsReady = false

  let botSpeaking = true
  let botEnd = 0
  const ECHO_MS = 1200

  let greetingDone = false
  let callTimer = null
  let noSpeechTimer = null
  let leadN = 0

  function stopTimers() {
    clearTimeout(callTimer)
    clearTimeout(noSpeechTimer)
  }

  function hangup(why) {
    console.log('[bridge] hangup:', why)
    stopTimers()
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
    ows.send(JSON.stringify({
      type: 'session.update',
      session: {
        turn_detection: {
          type: 'server_vad',
          threshold: 0.55,
          silence_duration_ms: 900,
          prefix_padding_ms: 200
        },
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        voice: 'shimmer',
        instructions: prompt,
        modalities: ['text', 'audio'],
        temperature: 0.7,
        input_audio_transcription: { model: 'whisper-1' },
        max_response_output_tokens: 180
      }
    }))
    ows.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '[Empieza la llamada]' }]
      }
    }))
    ows.send(JSON.stringify({ type: 'response.create' }))
    callTimer = setTimeout(() => hangup('max 3min'), 180000)
    owsReady = true
    flushBuffer()
    console.log('[bridge] session initialized')
  }

  function setupOws() {
    ows.on('message', raw => {
      let e
      try { e = JSON.parse(raw.toString()) } catch { return }

      if (e.type === 'response.audio.delta') {
        botSpeaking = true
        if (e.delta && streamSid && tws.readyState === 1) {
          tws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: e.delta } }))
        }
      } else if (e.type === 'response.audio.done') {
        botEnd = Date.now()
        if (streamSid && tws.readyState === 1) {
          tws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'd' } }))
        }
      } else if (e.type === 'response.done') {
        botSpeaking = false
        botEnd = Date.now()
        if (!greetingDone) {
          greetingDone = true
          console.log('[bridge] greeting done')
          noSpeechTimer = setTimeout(() => {
            if (leadN === 0) hangup('no lead speech')
          }, 22000)
        }
      } else if (e.type === 'input_audio_buffer.speech_started') {
        const age = Date.now() - botEnd
        if (botSpeaking || age < ECHO_MS) {
          console.log('[bridge] echo suppressed bot=' + botSpeaking + ' age=' + age)
          return
        }
        leadN++
        clearTimeout(noSpeechTimer)
        noSpeechTimer = null
        console.log('[bridge] lead speech #' + leadN)
      } else if (e.type === 'input_audio_buffer.speech_stopped') {
        console.log('[bridge] lead stopped #' + leadN)
      } else if (e.type === 'session.created') {
        console.log('[bridge] session created')
      } else if (e.type === 'error') {
        console.error('[bridge] oai error:', JSON.stringify(e.error))
      }
    })

    ows.on('close', code => {
      stopTimers()
      console.log('[bridge] oai closed code=' + code)
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
      ows = new WebSocket(OAI_URL, {
        headers: { Authorization: 'Bearer ' + KEY, 'OpenAI-Beta': 'realtime=v1' }
      })
      setupOws()
      ows.on('open', () => {
        console.log('[bridge] oai connected')
        initSession(prompt)
      })
    }
  }

  tws.on('message', raw => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }

    if (msg.event === 'connected') {
      console.log('[bridge] twilio connected')
    } else if (msg.event === 'start') {
      streamSid = msg.start?.streamSid || ''
      const rPid = (msg.start?.customParameters || {})['project_id'] || pid
      console.log('[bridge] stream started sid=' + streamSid + ' pid=' + rPid)
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
    try { if (ows?.readyState === 1) ows.close() } catch {}
  })

  tws.on('error', e => console.error('[bridge] twilio err:', e.message))
})

srv.listen(PORT, () => {
  console.log('[bridge] WAMKT Voice Bridge on port ' + PORT)
  for (let i = 0; i < POOL_SIZE; i++) newPoolWs()
})
