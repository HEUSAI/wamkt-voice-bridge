/**
 * WAMKT Voice Bridge
 * Bridges Twilio Media Streams (WebSocket) <-> OpenAI Realtime API (WebSocket)
 * Enables low-latency conversational AI voice calls (~1-2s response time)
 */

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

// Health check
app.get('/health', (req, res) => res.json({ ok: true, service: 'wamkt-voice-bridge' }))

// TwiML endpoint — Twilio calls this when call connects
// Returns TwiML that opens a Media Stream WebSocket back to this server
app.post('/voice/connect', (req, res) => {
  const projectId = req.query.project_id || ''
  const host = req.headers.host || req.hostname
  const wsUrl = `wss://${host}/voice/stream?project_id=${projectId}`

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

// HTTP server + WebSocket server on same port
const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/voice/stream' })

wss.on('connection', (twilioWs, req) => {
  const url = new URL('http://localhost' + req.url)
  const projectId = url.searchParams.get('project_id') || ''
  
  console.log(`[bridge] New call connected. project_id=${projectId}`)

  let openaiWs = null
  let streamSid = null
  let callSid = null
  let systemPrompt = null

  // Load system prompt from WAMKT (async, non-blocking)
  async function loadPrompt() {
    try {
      const r = await fetch(`${WAMKT_URL}/api/voice/agent-prompt?project_id=${projectId}`)
      if (r.ok) {
        const d = await r.json()
        systemPrompt = d.prompt
        console.log('[bridge] Prompt loaded, length:', systemPrompt?.length)
      }
    } catch (e) {
      console.warn('[bridge] Could not load prompt (using default):', e.message)
    }
    if (!systemPrompt) {
      systemPrompt = 'Eres Sofia, asistente de ventas de Empire Fitness. Llamas a un prospecto para presentar las promociones del mes. Habla en español mexicano, de forma natural y breve. Máximo 2 oraciones por turno. Sin emojis ni markdown. Si el lead no tiene interés, despídete cordialmente.'
    }
  }

  // Connect to OpenAI Realtime API
  function connectOpenAI() {
    const model = 'gpt-4o-realtime-preview-2024-12-17'
    openaiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${model}`,
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1',
        }
      }
    )

    openaiWs.on('open', () => {
      console.log('[bridge] OpenAI Realtime connected')

      // Configure session
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          turn_detection: { type: 'server_vad', threshold: 0.6, silence_duration_ms: 1000 },
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: 'shimmer', // Most natural Spanish voice in OpenAI
          instructions: systemPrompt,
          modalities: ['text', 'audio'],
          temperature: 0.7,
          input_audio_transcription: { model: 'whisper-1' },
        }
      }))

      // Send initial greeting trigger
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Empieza la llamada ahora.' }]
        }
      }))
      openaiWs.send(JSON.stringify({ type: 'response.create' }))
    })

    openaiWs.on('message', (data) => {
      const event = JSON.parse(data.toString())

      switch (event.type) {
        case 'response.audio.delta':
          // Stream audio back to Twilio in real time
          if (event.delta && streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: event.delta }
            }))
          }
          break

        case 'response.audio.done':
          // Mark end of response — Twilio keeps playing queued audio
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'response_done' } }))
          }
          break

        case 'input_audio_buffer.speech_started':
          // Lead started speaking — interrupt current response
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: 'clear', streamSid }))
          }
          break

        case 'error':
          console.error('[bridge] OpenAI error:', event.error)
          break
      }
    })

    openaiWs.on('close', () => {
      console.log('[bridge] OpenAI connection closed')
    })

    openaiWs.on('error', (err) => {
      console.error('[bridge] OpenAI WS error:', err.message)
    })
  }

  // Handle messages from Twilio
  twilioWs.on('message', (data) => {
    const msg = JSON.parse(data.toString())

    switch (msg.event) {
      case 'connected':
        console.log('[bridge] Twilio stream connected')
        break

      case 'start':
        streamSid = msg.start.streamSid
        callSid   = msg.start.callSid
        console.log(`[bridge] Stream started. StreamSid=${streamSid} CallSid=${callSid}`)
        // Load prompt then connect to OpenAI
        loadPrompt().then(connectOpenAI)
        break

      case 'media':
        // Forward audio from lead to OpenAI in real time
        if (openaiWs?.readyState === WebSocket.OPEN && msg.media?.payload) {
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media.payload
          }))
        }
        break

      case 'stop':
        console.log('[bridge] Stream stopped')
        if (openaiWs?.readyState === WebSocket.OPEN) {
          openaiWs.close()
        }
        break
    }
  })

  twilioWs.on('close', () => {
    console.log('[bridge] Twilio connection closed')
    if (openaiWs?.readyState === WebSocket.OPEN) {
      openaiWs.close()
    }
  })

  twilioWs.on('error', (err) => {
    console.error('[bridge] Twilio WS error:', err.message)
  })
})

server.listen(PORT, () => {
  console.log(`WAMKT Voice Bridge running on port ${PORT}`)
  console.log(`Health: http://localhost:${PORT}/health`)
})
