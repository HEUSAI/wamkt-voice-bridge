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

app.post('/voice/connect', (req, res) => {
  const projectId = req.query.project_id || ''
  const host = req.headers.host || req.hostname
  const wsUrl = `wss://${host}/voice/stream?project_id=${encodeURIComponent(projectId)}`
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
  // Read project_id from URL query param (may be empty if Railway strips WS query params)
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

  const MAX_CALL_MS = 3 * 60 * 1000
  const NO_SPEECH_MS = 12000

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

  async function loadPrompt(pid) {
    try {
      const r = await fetch(`${WAMKT_URL}/api/voice/agent-prompt?project_id=${encodeURIComponent(pid)}`, {
        signal: AbortSignal.timeout(5000)
      })
      if (r.ok) {
        const d = await r.json()
        if (d.prompt) {
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

  async function startBridge(pid) {
    const systemPrompt = await loadPrompt(pid)

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
            threshold: 0.5,
            silence_duration_ms: 800,
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
            twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'bot_speaking' } }))
          }
          break

        case 'response.done':
          if (!greetingDone) {
            greetingDone = true
            console.log('[bridge] Greeting done — waiting for lead')
            noSpeechTimer = setTimeout(() => hangup('no lead speech'), NO_SPEECH_MS)
          }
          break

        case 'input_audio_buffer.speech_started':
          clearTimeout(noSpeechTimer)
          noSpeechTimer = null
          console.log('[bridge] Lead speaking')
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: 'clear', streamSid }))
          }
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

        // PRIMARY: read project_id from Twilio customParameters (most reliable)
        const params = msg.start?.customParameters || {}
        const pidFromParams = params['project_id'] || ''
        
        // FALLBACK: use project_id from WebSocket URL
        const resolvedPid = pidFromParams || projectId

        console.log(`[bridge] Stream started. sid=${streamSid} project_id="${resolvedPid}" (params="${pidFromParams}" url="${projectId}")`)

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
