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

const DEFAULT_PROMPT = 'Eres Sofia, representante de ventas de Empire Fitness. Llamas a un prospecto para presentar las promociones del mes. Habla en español mexicano, tono amigable y directo. Maximo 2 oraciones por respuesta. Sin emojis ni markdown.'

app.get('/health', (req, res) => res.json({ ok: true, service: 'wamkt-voice-bridge' }))

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

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/voice/stream' })

wss.on('connection', (twilioWs, req) => {
  const url = new URL('http://localhost' + req.url)
  const projectId = url.searchParams.get('project_id') || ''
  console.log(`[bridge] New call. project_id=${projectId}`)

  let openaiWs = null
  let streamSid = null
  let isBotSpeaking = false

  async function loadPrompt() {
    try {
      const r = await fetch(`${WAMKT_URL}/api/voice/agent-prompt?project_id=${projectId}`, {
        signal: AbortSignal.timeout(5000)
      })
      if (r.ok) {
        const d = await r.json()
        if (d.prompt) {
          console.log('[bridge] Prompt loaded, length:', d.prompt.length)
          return d.prompt
        }
      }
    } catch (e) {
      console.warn('[bridge] Could not load prompt:', e.message)
    }
    console.log('[bridge] Using default prompt')
    return DEFAULT_PROMPT
  }

  async function startBridge() {
    const systemPrompt = await loadPrompt()

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
      console.log('[bridge] OpenAI connected. Configuring session...')

      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          turn_detection: {
            type: 'server_vad',
            threshold: 0.6,
            silence_duration_ms: 1200,
            create_response: true,
            interrupt_response: true,
          },
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: 'shimmer',
          instructions: systemPrompt,
          modalities: ['text', 'audio'],
          temperature: 0.7,
          input_audio_transcription: { model: 'whisper-1' },
          max_response_output_tokens: 150,
        }
      }))

      openaiWs.send(JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['text', 'audio'],
          instructions: 'Inicia la llamada ahora. Saluda e introdúcete mencionando de dónde llamas y el motivo brevemente.',
        }
      }))
    })

    openaiWs.on('message', (data) => {
      let event
      try { event = JSON.parse(data.toString()) } catch { return }

      switch (event.type) {
        case 'response.audio.delta':
          isBotSpeaking = true
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
          isBotSpeaking = false
          break

        case 'input_audio_buffer.speech_started':
          isBotSpeaking = false
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: 'clear', streamSid }))
          }
          if (openaiWs?.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({ type: 'response.cancel' }))
          }
          break

        case 'error':
          console.error('[bridge] OpenAI error:', JSON.stringify(event.error))
          break

        case 'session.created':
          console.log('[bridge] Session created ok')
          break
      }
    })

    openaiWs.on('close', () => console.log('[bridge] OpenAI WS closed'))
    openaiWs.on('error', (err) => console.error('[bridge] OpenAI WS error:', err.message))
  }

  twilioWs.on('message', (data) => {
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }

    switch (msg.event) {
      case 'connected':
        console.log('[bridge] Twilio stream connected')
        break

      case 'start':
        streamSid = msg.start.streamSid
        console.log(`[bridge] Stream started. sid=${streamSid}`)
        startBridge()
        break

      case 'media':
        if (openaiWs?.readyState === WebSocket.OPEN && msg.media?.payload && !isBotSpeaking) {
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media.payload
          }))
        }
        break

      case 'mark':
        break

      case 'stop':
        console.log('[bridge] Stream stopped')
        openaiWs?.close?.()
        break
    }
  })

  twilioWs.on('close', () => {
    console.log('[bridge] Twilio WS closed')
    openaiWs?.close?.()
  })

  twilioWs.on('error', (err) => console.error('[bridge] Twilio WS error:', err.message))
})

server.listen(PORT, () => {
  console.log(`WAMKT Voice Bridge on port ${PORT}`)
})
