import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function verifyToken(
  token: string,
  secret: string
): Promise<{ id: string; email: string } | null> {
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
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    )
    const sigBytes = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0))
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      new TextEncoder().encode(payload)
    )
    if (!valid) return null
    return { id, email }
  } catch {
    return null
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const authHeader = req.headers.get('Authorization') ?? ''
    if (!authHeader.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Token manquant' }),
        { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const token = authHeader.slice(7)
    const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const identity = await verifyToken(token, secret)

    if (!identity) {
      return new Response(
        JSON.stringify({ error: 'Token invalide ou expiré' }),
        { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const { tx_id } = await req.json()

    if (!tx_id) {
      return new Response(
        JSON.stringify({ error: 'tx_id manquant' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data: tx, error: fetchErr } = await sb
      .from('client_transactions')
      .select('tx_id, status, payment_declared, email')
      .eq('tx_id', tx_id)
      .eq('email', identity.email)
      .maybeSingle()

    if (fetchErr || !tx) {
      return new Response(
        JSON.stringify({ error: 'Transaction introuvable' }),
        { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    if (tx.status !== 'pending' || tx.payment_declared) {
      return new Response(
        JSON.stringify({ error: 'Cette transaction ne peut plus être annulée' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const { error: updErr } = await sb
      .from('client_transactions')
      .update({ status: 'cancelled_by_user', updated_at: new Date().toISOString() })
      .eq('tx_id', tx_id)
      .eq('email', identity.email)

    if (updErr) {
      return new Response(
        JSON.stringify({ error: 'Erreur lors de l\'annulation' }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  } catch (_e) {
    return new Response(
      JSON.stringify({ error: 'Erreur serveur' }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  }
})
