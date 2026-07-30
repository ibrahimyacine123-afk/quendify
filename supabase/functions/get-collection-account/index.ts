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

    const { currency, country_code } = await req.json()

    if (!currency || !country_code) {
      return new Response(
        JSON.stringify({ error: 'currency et country_code requis' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const VALID_COUNTRIES = ['TR','BJ','CM','GA','CG','CI']
    if (!VALID_COUNTRIES.includes(country_code)) {
      return new Response(
        JSON.stringify({ error: 'Pays invalide' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data: accounts, error } = await sb
      .from('qnd_collection_accounts')
      .select('*')
      .eq('currency', currency)
      .eq('active', true)
      .or(`country_code.is.null,country_code.eq.${country_code}`)
      .order('sort_order')

    if (error) {
      return new Response(
        JSON.stringify({ error: 'Erreur base de données' }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify(accounts ?? []),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  } catch (_e) {
    return new Response(
      JSON.stringify({ error: 'Erreur serveur' }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  }
})
