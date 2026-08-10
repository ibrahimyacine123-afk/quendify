import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const FIXED_EUR = { XOF: 655.957, XAF: 655.957 }
const RATE_FETCH_TIMEOUT_MS = 5000

// Reprend la logique de get-rate pour garantir la même source de taux
// que celle affichée au client avant soumission.
async function fetchLiveRate(from: string, to: string): Promise<number | null> {
  if (from === to) return 1
  const norm = (c: string) => c === 'USDT' ? 'USD' : c
  const f = norm(from)
  const t = norm(to)

  let eur: Record<string, number> = {}

  const controller1 = new AbortController()
  const timeout1 = setTimeout(() => controller1.abort(), RATE_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/EUR', { signal: controller1.signal })
    const data = await res.json()
    if (data && data.rates) eur = data.rates
  } catch (e) { console.log('er-api fail', (e as Error).message) }
  clearTimeout(timeout1)

  if (!eur.TRY) {
    const controller2 = new AbortController()
    const timeout2 = setTimeout(() => controller2.abort(), RATE_FETCH_TIMEOUT_MS)
    try {
      const res2 = await fetch('https://api.frankfurter.app/latest?from=EUR', { signal: controller2.signal })
      const d2 = await res2.json()
      if (d2 && d2.rates) eur = { ...d2.rates, ...eur }
    } catch (e) { console.log('frankfurter fail', (e as Error).message) }
    clearTimeout(timeout2)
  }

  eur.XOF = FIXED_EUR.XOF
  eur.XAF = FIXED_EUR.XAF
  eur.EUR = 1

  const rf = f === 'EUR' ? 1 : eur[f]
  const rt = t === 'EUR' ? 1 : eur[t]
  if (!rf || !rt) return null

  return rt / rf
}

async function verifyToken(token: string, secret: string): Promise<{ id: string; email: string } | null> {
  try {
    const dotIdx = token.lastIndexOf('.')
    if (dotIdx === -1) return null
    const payloadB64 = token.slice(0, dotIdx)
    const sigB64 = token.slice(dotIdx + 1)
    const payload = atob(payloadB64)
    const parts = payload.split(':')
    if (parts.length < 3) return null
    const exp = parseInt(parts[parts.length - 1])
    const id = parts[0]
    const email = parts.slice(1, -1).join(':')
    if (Date.now() > exp) return null
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    )
    const sigBytes = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0))
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(payload))
    if (!valid) return null
    return { id, email }
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const authHeader = req.headers.get('Authorization') ?? ''
    if (!authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Token manquant' }), { status: 401, headers: CORS })
    }
    const identity = await verifyToken(authHeader.slice(7), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    if (!identity) {
      return new Response(JSON.stringify({ error: 'Session invalide ou expirée' }), { status: 401, headers: CORS })
    }

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const { data: activeCheck } = await sb
      .from('quendify_users')
      .select('is_active')
      .eq('email', identity.email)
      .maybeSingle()
    if (!activeCheck || !activeCheck.is_active) {
      return new Response(JSON.stringify({ error: 'Compte suspendu.' }), { status: 403, headers: CORS })
    }

    const { from_currency, to_currency, amount_send, first_name, last_name,
            recipient_momo, recipient_country, motif, pay_mode, phone } = await req.json()

    if (!amount_send || amount_send <= 0) {
      return new Response(JSON.stringify({ error: 'Montant invalide' }), { status: 400, headers: CORS })
    }

    const { data: corridor } = await sb
      .from('qnd_corridors')
      .select('margin, rate')
      .eq('from_currency', from_currency)
      .eq('to_currency', to_currency)
      .eq('active', true)
      .maybeSingle()
    if (!corridor) {
      return new Response(JSON.stringify({ error: 'Corridor non disponible' }), { status: 400, headers: CORS })
    }

    const { data: member } = await sb
      .from('quendify_users')
      .select('email, phone, full_name')
      .eq('id', identity.id)
      .maybeSingle()
    if (!member) {
      return new Response(JSON.stringify({ error: 'Compte introuvable' }), { status: 401, headers: CORS })
    }

    const margin = parseFloat(corridor.margin) || 0.05
    const liveRate = await fetchLiveRate(from_currency, to_currency)
    const rate = liveRate ?? (parseFloat(corridor.rate) || 1)
    const amount_receive = parseFloat((amount_send * (1 - margin) * rate).toFixed(2))
    const txId = 'QND-' + Date.now().toString(36).toUpperCase()

    const { error } = await sb.from('client_transactions').insert([{
      tx_id: txId, amount_send, currency_from: from_currency,
      amount_receive, currency_to: to_currency,
      rate, margin, first_name, last_name,
      email: member.email,
      phone: member.phone || phone || null,
      recipient_momo, recipient_country, motif,
      status: 'pending', pay_mode
    }])

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: CORS })
    }
    return new Response(JSON.stringify({ ok: true, tx_id: txId, amount_receive, rate, margin }), {
      headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: CORS })
  }
})
