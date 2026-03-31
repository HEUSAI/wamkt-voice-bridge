require('dotenv').config()
const express = require('express')
const { WebSocketServer, WebSocket } = require('ws')
const http = require('http')

const app = express()
app.use(express.urlencoded({ extended: false }))
app.use(express.json())

const PORT = process.env.PORT || 3001
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
const WAMKT_URL = process.env.WAMKT_URL || 'https://wamkt.notsy.com.mx'
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17'
const DEFAULT_PROMPT = 'Eres representante de ventas. Llamas para presentar una promoción. Español mexicano, amigable y directo. Máximo 2 oraciones. Sin emojis ni markdown.'

// Prompt cache
const promptCache = new Map()
const promptInFlight = new Map()
const CACHE_TTL = 5 * 60 * 1000

async function fetchPrompt(pid) {
  const c = promptCache.get(pid)
  if (c && Date.now() - c.ts < CACHE_TTL) return c.prompt
  if (promptInFlight.has(pid)) return promptInFlight.get(pid)
  const p = (async () => {
    try {
      const r = await fetch(WAMKT_URL + '/api/voice/agent-prompt?project_id=' + encodeURIComponent(pid), { signal: AbortSignal.timeout(4000) })
      if (r.ok) { const d = await r.json(); if (d.prompt) { promptCache.set(pid, { prompt: d.prompt, ts: Date.now() }); console.log('[bridge] Prompt loaded pid=' + pid + ' len=' + d.prompt.length); return d.prompt } }
    } catch (e) { console.warn('[bridge] prompt fetch failed:', e.message) }
    return DEFAULT_PROMPT
  })()
  promptInFlight.set(pid, p); p.finally(() => promptInFlight.delete(pid)); return p
}

// OpenAI WebSocket pool — pre-warm 2 connections to eliminate handshake latency
const POOL_SIZE = 2
const pool = []

function createPooledWs() {
  if (!OPENAI_API_KEY) return
  const ws = new WebSocket(OPENAI_REALTIME_URL, { headers: { Authorization: 'Bearer ' + OPENAI_API_KEY, 'OpenAI-Beta': 'realtime=v1' } })
  ws._ready = false
  ws.on('open', () => { ws._ready = true; console.log('[pool] ready ' + pool.filter(w=>w._ready).length + '/' + POOL_SIZE) })
  ws.on('error', e => { console.warn('[pool] err:', e.message); const i = pool.indexOf(ws); if (i !== -1) pool.splice(i,1); setTimeout(refillPool, 1000) })
  ws.on('close', () => { const i = pool.indexOf(ws); if (i !== -1) pool.splice(i,1) })
  pool.push(ws)
}

function refillPool() {
  const live = pool.filter(w => w.readyState === WebSocket.OPEN || w.readyState === WebSocket.CONNECTING).length
  for (let i = live; i < POOL_SIZE; i++) createPooledWs()
}

function grabPooledWs() {
  const i = pool.findIndex(w => w._ready && w.readyState === WebSocket.OPEN)
  if (i === -1) return null
  const ws = pool.splice(i, 1)[0]; console.log('[pool] handed off remaining=' + pool.length)
  setTimeout(refillPool, 500); return ws
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'wamkt-voice-bridge', pool: pool.filter(w=>w._ready).length + '/' + POOL_SIZE }))

app.post('/voice/connect', (req, res) => {
  const pid = req.query.project_id || ''
  const host = req.headers.host || req.hostname
  const wsUrl = 'wss://' + host + '/voice/stream?project_id=' + encodeURIComponent(pid)
  if (pid) fetchPrompt(pid).catch(() => {})
  refillPool()
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="' + wsUrl + '"><Parameter name="project_id" value="' + pid + '"/></Stream></Connect></Response>')
})

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/voice/stream' })

wss.on('connection', (tws, req) => {
  let pid = ''
  try { pid = new URL('http://x' + req.url).searchParams.get('project_id') || '' } catch {}

  let ows = null, streamSid = null
  let botSpeaking = true, botAudioEnd = 0
  const ECHO_MS = 1200
  let greetingDone = false, callTimer = null, noSpeechTimer = null, leadSpeech = 0
  const MAX_MS = 180000, NO_SPEECH_MS = 22000

  function clearTimers() { clearTimeout(callTimer); clearTimeout(noSpeechTimer) }

  function hangup(reason) {
    console.log('[bridge] Hangup:', reason); clearTimers()
    try { if (ows?.readyState === WebSocket.OPEN) ows.close() } catch {}
    try { if (tws.readyState === WebSocket.OPEN) tws.close() } catch {}
  }

  function send(obj) { if (ows?.readyState === WebSocket.OPEN) ows.send(JSON.stringify(obj)) }

  function startSession(prompt) {
    send({ type: 'session.update', session: { turn_detection: { type: 'server_vad', threshold: 0.6, silence_duration_ms: 1000, prefix_padding_ms: 300 }, input_audio_format: 'g711_ulaw', output_audio_format: 'g711_ulaw', voice: 'shimmer', instructions: prompt, modalities: ['text','audio'], temperature: 0.7, input_audio_transcription: { model: 'whisper-1' }, max_response_output_tokens: 200 } })
    send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[Empieza la llamada]' }] } })
    send({ type: 'response.create' })
    callTimer = setTimeout(() => hangup('max duration'), MAX_MS)
    console.log('[bridge] Session started')
  }

  function attachOws() {
    ows.on('message', data => {
      let e; try { e = JSON.parse(data.toString()) } catch { return }
      if (e.type === 'response.audio.delta') {
        botSpeaking = true
        if (e.delta && streamSid && tws.readyState === WebSocket.OPEN)
          tws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: e.delta } }))
      } else if (e.type === 'response.audio.done') {
        botAudioEnd = Date.now()
        if (streamSid && tws.readyState === WebSocket.OPEN)
          tws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'done' } }))
      } else if (e.type === 'response.done') {
        botSpeaking = false; botAudioEnd = Date.now()
        if (!greetingDone) {
          greetingDone = true; console.log('[bridge] Greeting done')
          noSpeechTimer = setTimeout(() => { if (leadSpeech === 0) hangup('no lead speech') }, NO_SPEECH_MS)
        }
      } else if (e.type === 'input_audio_buffer.speech_started') {
        const age = Date.now() - botAudioEnd
        if (botSpeaking || age < ECHO_MS) { console.log('[bridge] Echo suppressed bot=' + botSpeaking + ' age=' + age + 'ms'); return }
        leadSpeech++; clearTimeout(noSpeechTimer); noSpeechTimer = null
        console.log('[bridge] Lead speech #' + leadSpeech)
      } else if (e.type === 'input_audio_buffer.speech_stopped') {
        console.log('[bridge] Lead stopped #' + leadSpeech)
      } else if (e.type === 'error') {
        console.error('[bridge] OAI error:', JSON.stringify(e.error))
      } else if (e.type === 'session.created') {
        console.log('[bridge] Session created')
      }
    })
    ows.on('close', code => { clearTimers(); console.log('[bridge] OAI closed code=' + code); try { if (tws.readyState === WebSocket.OPEN) tws.close() } catch {} })
    ows.on('error', err => console.error('[bridge] OAI err:', err.message))
  }

  async function startBridge(resolvedPid) {
    const prompt = await fetchPrompt(resolvedPid)
    const pooled = grabPooledWs()
    if (pooled) {
      console.log('[bridge] Pooled WS — instant start')
      ows = pooled; attachOws(); startSession(prompt)
    } else {
      console.log('[bridge] Fresh WS')
      ows = new WebSocket(OPENAI_REALTIME_URL, { headers: { Authorization: 'Bearer ' + OPENAI_API_KEY, 'OpenAI-Beta': 'realtime=v1' } })
      attachOws()
      ows.on('open', () => { console.log('[bridge] OAI connected'); startSession(prompt) })
    }
  }

  tws.on('message', data => {
    let msg; try { msg = JSON.parse(data.toString()) } catch { return }
    if (msg.event === 'connected') { console.log('[bridge] Twilio connected') }
    else if (msg.event === 'start') {
      streamSid = msg.start?.streamSid || ''
      const p = (msg.start?.customParameters || {})['project_id'] || pid
      console.log('[bridge] Stream started sid=' + streamSid + ' pid=' + p)
      startBridge(p)
    } else if (msg.event === 'media') {
      if (ows?.readyState === WebSocket.OPEN && msg.media?.payload)
        ows.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }))
    } else if (msg.event === 'stop') {
      hangup('stream stopped')
    }
  })

  tws.on('close', () => { clearTimers(); console.log('[bridge] Twilio closed'); try { if (ows?.readyState === WebSocket.OPEN) ows.close() } catch {} })
  tws.on('error', err => console.error('[bridge] Twilio err:', err.message))
})

server.listen(PORT, () => {
  console.log('WAMKT Voice Bridge on port ' + PORT)
  console.log('[pool] Warming up ' + POOL_SIZE + ' connections...')
  for (let i = 0; i < POOL_SIZE; i++) createPooledWs()
})
