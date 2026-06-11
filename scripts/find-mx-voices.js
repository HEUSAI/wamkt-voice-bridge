// Busca voces de ESPAÑOL MEXICANO en la biblioteca compartida de ElevenLabs.
// Uso:  ELEVEN_LABS_API_KEY=xi-... node scripts/find-mx-voices.js
const KEY = process.env.ELEVEN_LABS_API_KEY || process.env.ELEVEN_API_KEY || ''
if (!KEY) { console.error('FALTA ELEVEN_LABS_API_KEY'); process.exit(1) }

const params = new URLSearchParams({ page_size: '60', language: 'es' })
const url = 'https://api.elevenlabs.io/v1/shared-voices?' + params.toString()

;(async () => {
  const r = await fetch(url, { headers: { 'xi-api-key': KEY } })
  if (!r.ok) { console.error('Error', r.status, await r.text()); process.exit(1) }
  const d = await r.json()
  const all = d.voices || []
  // Filtra acento mexicano / latino
  const mx = all.filter(v => {
    const blob = JSON.stringify(v).toLowerCase()
    return blob.includes('mexic') || (v.accent && /mexic|latin/.test(String(v.accent).toLowerCase()))
  })
  const list = (mx.length ? mx : all).slice(0, 20)
  console.log(`\n${mx.length} voces mexicanas/latinas (de ${all.length} en español):\n`)
  list.forEach(v => {
    console.log(`• ${v.name}  [${v.gender || '?'} | ${v.accent || 'es'}]`)
    console.log(`  voice_id: ${v.voice_id}`)
    if (v.preview_url) console.log(`  muestra:  ${v.preview_url}`)
    if (v.description) console.log(`  ${String(v.description).slice(0, 90)}`)
    console.log('')
  })
  console.log('Para usar una: agrégala a tu cuenta en elevenlabs.io (botón "Add") o pásame el voice_id.')
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
