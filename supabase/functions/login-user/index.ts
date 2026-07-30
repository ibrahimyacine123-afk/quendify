import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function signToken(userId: string, email: string, secret: string): Promise<string> {
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000
  const payload = `${userId}:${email}:${exp}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return btoa(payload) + '.' + sigB64
}

async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16)
  crypto.getRandomValues(salt)
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' },
    keyMaterial, 256
  )
  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(bits)))
  const saltB64 = btoa(String.fromCharCode(...salt))
  return `pbkdf2$210000$${saltB64}$${hashB64}`
}

async function verifyPassword(password: string, stored: string): Promise<{ ok: boolean; newHash?: string }> {
  if (stored.startsWith('pbkdf2$')) {
    const [, iterStr, saltB64, hashB64] = stored.split('$')
    const iterations = parseInt(iterStr, 10)
    const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0))
    const keyMaterial = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
    )
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      keyMaterial, 256
    )
    const computedB64 = btoa(String.fromCharCode(...new Uint8Array(bits)))
    return { ok: computedB64 === hashB64 }
  }

  if (atob(stored) === password) {
    return { ok: true, newHash: await hashPassword(password) }
  }

  return { ok: false }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { email, password } = await req.json()

    if (!email || !password) {
      return new Response(
        JSON.stringify({ error: 'Champs manquants' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const safeEmail = email.trim().toLocaleLowerCase('en-US')

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data: user, error } = await sb
      .from('quendify_users')
      .select('id, full_name, email, phone, whatsapp, iban_holder, iban_try, reception_number, country, email_verified, created_at, password_hash, is_active')
      .eq('email', safeEmail)
      .maybeSingle()

    if (error || !user) {
      return new Response(
        JSON.stringify({ error: 'Email ou code d\'accès incorrect' }),
        { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const { ok, newHash } = await verifyPassword(password, user.password_hash)

    if (!ok) {
      return new Response(
        JSON.stringify({ error: 'Email ou code d\'accès incorrect' }),
        { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    if (!user.is_active) {
      return new Response(
        JSON.stringify({ error: 'Compte suspendu. Contactez le support.' }),
        { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    if (newHash) {
      await sb.from('quendify_users').update({ password_hash: newHash }).eq('id', user.id)
    }

    delete (user as { password_hash?: string }).password_hash
    delete (user as { is_active?: boolean }).is_active

    const token = await signToken(
      String(user.id),
      user.email,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    return new Response(
      JSON.stringify({ user, token }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  } catch (_e) {
    return new Response(
      JSON.stringify({ error: 'Erreur serveur' }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  }
})
