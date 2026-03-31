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

const DEFAULT_PROMPT = 'Eres un representante de ventas. Llamas a un prospecto para presentar una promoción. Habla en español mexicano, tono amigable y directo. Máximo 2 oraciones por respuesta. Sin emojis ni markdown.'

app.get('/health', (req, res) => res.json({ ok: true, service: 'wamkt-voice-bridge' }))

// Prompt cache with deduplication
const promptCache = new Map()
const promptInFlight = new Map()
const CACHE_TTL_MS = 5 * 60 * 1000

async function fetchPrompt(pid) {
  const cached = promptCache.get(pid)
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) return cached.prompt
  if (promptInFlight.has(pid)) return promptInFlight.get(pid)
  const p = (async () => {
    try {
      const r = await fetch(`${WAMKT_URL}/api/voice/agent-prompt?project_id=${encodeURIComponent(pid)}`, {
        signal: AbortSignal.timeout(4000)
      })
      if (r.ok) {
        const d = await r.json()
        if (d.prompt) {
          promptCache.set(pid, { prompt: d.prompt, ts: Date.now() })
          console.log(`[bridge] Prompt loaded project="${pid}" length=${d.prompt.length}`)
          return d.prompt
        }
      }
    } catch (e) { console.warn('[bridge] Prompt fetch failed:', e.message) }
    return DEFAULT_PROMPT
  })()
  promptInFlight.set(pid, p)
  p.finally(() => promptInFlight.delete(pid))
  return p
}

app.post('/voice/connect', (req, res) => {
  const projectId = req.query.project_id || ''
  const host = req.headers.host || req.hostname
  const wsUrl = `wss://${host}/voice/stream?project_id=${encodeURIComponent(projectId)}`
  if (projectId) fetchPrompt(projectId).catch(() => {})
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="project_id" value="${projectId}"/>
    </Stream>
  </Connect>
</Response>`
  res.type('text/xml').send(twiml)
})

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/voice/stream' })

wss.on('connection', (twilioWs, req) => {
  let projectId = ''
  try { projectId = new URL('http://localhost' + req.url).searchParams.get('project_id') || '' } catch {}

  let openaiWs = null
  let streamSid = null

  // Bot speaking state — track to know when to suppress echo and when to clear Twilio buffer
  let botSpeaking = true   // starts true: bot will speak first
  let botAudioEndTime = 0  // when bot last finished audio chunk
  const ECHO_CLEARANCE_MS = 1200  // ignore VAD triggers for 1.2s after bot finishes

  // Call state
  let greetingComplete = false
  let callTimer = null
  let noSpeechTimer = null
  let realLeadSpeechCount = 0

  const MAX_CALL_MS = 3 * 60 * 1000
  const NO_SPEECH_MS = 22000

  function clearTimers() { clearTimeout(callTimer); clearTimeout(noSpeechTimer) }

  function hangup(reason) {
    console.log(`[bridge] Hangup: ${reason}`)
    clearTimers()
    try { if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close() } catch {}
    try { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close() } catch {}
  }

  async function startBridge(pid) {
    const systemPrompt = await fetchPrompt(pid)

    openaiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
      { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
    )

    openaiWs.on('open', () => {
      console.log('[bridge] OpenAI connected')

      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          turn_detection: {
            type: 'server_vad',
            threshold: 0.6,
            silence_duration_ms: 1000,
            prefix_padding_ms: 300,
          },
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: 'shimmer',
          instructions: systemPrompt,
          modalities: ['text', 'audio'],
          temperature: 0.7,
          input_audio_transcription: { model: 'whisper-1' },
          max_response_output_tokens: 200,
        }
      }))

      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[Empieza la llamada]' }] }
      }))
      openaiWs.send(JSON.stringify({ type: 'response.create' }))

      callTimer = setTimeout(() => hangup('max duration'), MAX_CALL_MS)
    })

    openaiWs.on('message', (data) => {
      let event
      try { event = JSON.parse(data.toString()) } catch { return }

      switch (event.type) {

        case 'response.audio.delta':
          botSpeaking = true
          if (event.delta && streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: event.delta } }))
          }
          break

        case 'response.audio.done':
          botAudioEndTime = Date.now()
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'bot_done' } }))
          }
          break

        case 'response.done':
          botSpeaking = false
          botAudioEndTime = Date.now()
          if (!greetingComplete) {
            greetingComplete = true
            console.log('[bridge] Greeting complete — listening for lead')
            noSpeechTimer = setTimeout(() => {
              if (realLeadSpeechCount === 0) hangup('no lead speech after greeting')
            }, NO_SPEECH_MS)
          }
          break

        case 'input_audio_buffer.speech_started': {
          const echoAge = Date.now() - botAudioEndTime
          if (botSpeaking || echoAge < ECHO_CLEARANCE_MS) {
            console.log(`[bridge] Echo suppressed (botSpeaking=${botSpeaking} echoAge=${echoAge}ms)`)
            break
          }
          // Real lead speech
          realLeadSpeechCount++
          clearTimeout(noSpeechTimer)
          noSpeechTimer = null
          console.log(`[bridge] Lead speech #${realLeadSpeechCount}`)
          // Only clear Twilio buffer if bot was speaking (interruption scenario)
          // DO NOT send clear when bot has already finished — it disrupts the media stream
          if (botSpeaking && streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: 'clear', streamSid }))
          }
          break
        }

        case 'input_audio_buffer.speech_stopped':
          console.log(`[bridge] Lead speech stopped #${realLeadSpeechCount}`)
          break

        case 'error':
          console.error('[bridge] OpenAI error:', JSON.stringify(event.error))
          break

        case 'session.created':
          console.log('[bridge] Session created')
          break
      }
    })

    openaiWs.on('close', (code, reason) => {
      clearTimers()
      console.log(`[bridge] OpenAI WS closed code=${code} reason=${reason?.toString() || 'none'}`)
      // If OpenAI closes unexpectedly during active call, close Twilio too
      try { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close() } catch {}
    })

    openaiWs.on('error', (err) => console.error('[bridge] OpenAI WS error:', err.message))
  }

  twilioWs.on('message', (data) => {
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }

    switch (msg.event) {
      case 'connected':
        console.log('[bridge] Twilio connected')
        break

      case 'start': {
        streamSid = msg.start?.streamSid || ''
        const params = msg.start?.customParameters || {}
        const resolvedPid = params['project_id'] || projectId
        console.log(`[bridge] Stream started sid=${streamSid} project_id="${resolvedPid}"`)
        startBridge(resolvedPid)
        break
      }

      case 'media':
        if (openaiWs?.readyState === WebSocket.OPEN && msg.media?.payload) {
          openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }))
        }
        break

      case 'stop':
        hangup('stream stopped')
        break
    }
  })

  twilioWs.on('close', () => {
    clearTimers()
    console.log('[bridge] Twilio WS closed')
    try { if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close() } catch {}
  })

  twilioWs.on('error', (err) => console.error('[bridge] Twilio WS error:', err.message))
})

server.listen(PORT, () => console.log(`WAMKT Voice Bridge on port ${PORT}`))
