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

const DEFAULT_PROMPT = 'Eres un representante de ventas. Llamas a un prospecto para presentar una promoción del mes. Habla en español mexicano, tono amigable y directo. Máximo 2 oraciones por respuesta. Sin emojis ni markdown.'

app.get('/health', (req, res) => res.json({ ok: true, service: 'wamkt-voice-bridge' }))

// Prompt cache: project_id -> { prompt, ts }
// Avoids HTTP fetch on every call — refreshes every 5 minutes
const promptCache = new Map()
const CACHE_TTL_MS = 5 * 60 * 1000

async function fetchPrompt(pid) {
  const cached = promptCache.get(pid)
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
    console.log(`[bridge] Prompt from cache for project="${pid}", length:`, cached.prompt.length)
    return cached.prompt
  }
  try {
    const r = await fetch(`${WAMKT_URL}/api/voice/agent-prompt?project_id=${encodeURIComponent(pid)}`, {
      signal: AbortSignal.timeout(4000)
    })
    if (r.ok) {
      const d = await r.json()
      if (d.prompt) {
        promptCache.set(pid, { prompt: d.prompt, ts: Date.now() })
        console.log(`[bridge] Prompt loaded for project="${pid}", length:`, d.prompt.length)
        return d.prompt
      }
    }
  } catch (e) {
    console.warn('[bridge] Could not load prompt:', e.message)
  }
  console.log('[bridge] Using default prompt')
  return DEFAULT_PROMPT
}

app.post('/voice/connect', async (req, res) => {
  const projectId = req.query.project_id || ''
  const host = req.headers.host || req.hostname
  const wsUrl = `wss://${host}/voice/stream?project_id=${encodeURIComponent(projectId)}`

  // PRE-WARM: start fetching prompt immediately when call connects (before WS opens)
  if (projectId) {
    fetchPrompt(projectId).catch(() => {})
  }

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
  try {
    const urlObj = new URL('http://localhost' + req.url)
    projectId = urlObj.searchParams.get('project_id') || ''
  } catch {}

  console.log(`[bridge] New call. project_id from URL="${projectId}"`)

  let openaiWs = null
  let streamSid = null
  let greetingDone = false
  let callTimer = null
  let noSpeechTimer = null
  let leadSpeechCount = 0

  const MAX_CALL_MS = 3 * 60 * 1000   // 3 min max total
  const NO_SPEECH_MS = 18000          // 18s — generous window for lead to respond after greeting

  function clearTimers() {
    clearTimeout(callTimer)
    clearTimeout(noSpeechTimer)
  }

  function hangup(reason) {
    console.log(`[bridge] Hanging up: ${reason}`)
    clearTimers()
    try { if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close() } catch {}
    try { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close() } catch {}
  }

  async function startBridge(pid) {
    // Prompt should already be cached from voice/connect pre-warm
    const systemPrompt = await fetchPrompt(pid)

    openaiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1',
        }
      }
    )

    openaiWs.on('open', () => {
      console.log('[bridge] OpenAI connected')

      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          turn_detection: {
            type: 'server_vad',
            threshold: 0.55,       // slightly higher → less false positives from bot audio
            silence_duration_ms: 600,  // faster response after lead stops speaking
            prefix_padding_ms: 200,
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

      // Trigger greeting
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '[Empieza la llamada]' }]
        }
      }))
      openaiWs.send(JSON.stringify({ type: 'response.create' }))

      // Max call timer
      callTimer = setTimeout(() => hangup('max duration'), MAX_CALL_MS)
    })

    openaiWs.on('message', (data) => {
      let event
      try { event = JSON.parse(data.toString()) } catch { return }

      switch (event.type) {
        case 'response.audio.delta':
          if (event.delta && streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: event.delta }
            }))
          }
          break

        case 'response.audio.done':
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'bot_done' } }))
          }
          break

        case 'response.done':
          // Only mark greeting done after FIRST complete response from bot
          // AND start no-speech timer only then (not before bot finishes speaking)
          if (!greetingDone) {
            greetingDone = true
            console.log('[bridge] Greeting done — waiting for lead')
            noSpeechTimer = setTimeout(() => {
              if (leadSpeechCount === 0) {
                hangup('no lead speech')
              }
            }, NO_SPEECH_MS)
          }
          break

        case 'input_audio_buffer.speech_started':
          // Lead OR bot audio detected — increment to track real lead speech
          leadSpeechCount++
          clearTimeout(noSpeechTimer)
          noSpeechTimer = null
          console.log('[bridge] Speech detected (#' + leadSpeechCount + ')')
          // Clear any bot audio still buffered in Twilio
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: 'clear', streamSid }))
          }
          break

        case 'input_audio_buffer.speech_stopped':
          // Lead stopped speaking — log only
          console.log('[bridge] Speech stopped')
          break

        case 'error':
          console.error('[bridge] OpenAI error:', JSON.stringify(event.error))
          break

        case 'session.created':
          console.log('[bridge] Session created')
          break
      }
    })

    openaiWs.on('close', () => { clearTimers(); console.log('[bridge] OpenAI WS closed') })
    openaiWs.on('error', (err) => console.error('[bridge] OpenAI WS error:', err.message))
  }

  twilioWs.on('message', (data) => {
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }

    switch (msg.event) {
      case 'connected':
        console.log('[bridge] Twilio connected')
        break

      case 'start':
        streamSid = msg.start?.streamSid || ''
        // PRIMARY: Twilio customParameters (most reliable through Railway proxy)
        const params = msg.start?.customParameters || {}
        const pidFromParams = params['project_id'] || ''
        const resolvedPid = pidFromParams || projectId
        console.log(`[bridge] Stream started. sid=${streamSid} project_id="${resolvedPid}"`)
        startBridge(resolvedPid)
        break

      case 'media':
        if (openaiWs?.readyState === WebSocket.OPEN && msg.media?.payload) {
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media.payload
          }))
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

server.listen(PORT, () => {
  console.log(`WAMKT Voice Bridge on port ${PORT}`)
})
