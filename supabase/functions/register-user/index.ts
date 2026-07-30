import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
}

async function signToken(userId: string, email: string, secret: string): Promise<string> {
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000
  const payload = `${userId}:${email}:${exp}`
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { email, password, full_name, whatsapp, iban_holder, iban_try, reception_number } = await req.json()

    if (!email || !password || !full_name || !whatsapp || !iban_holder || !iban_try || !reception_number) {
      return new Response(JSON.stringify({ error: 'Champs manquants' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    if (password.length < 8) {
      return new Response(JSON.stringify({ error: 'Code d\'accès trop court (8 caractères minimum)' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const safeEmail = email.trim().toLocaleLowerCase('en-US')

    const { data: existing } = await sb
      .from('quendify_users')
      .select('id')
      .eq('email', safeEmail)
      .maybeSingle()

    if (existing) {
      return new Response(JSON.stringify({ error: 'Un accès existe déjà avec cet email' }), {
        status: 409, headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    const password_hash = await hashPassword(password)

    const { data: user, error: insertError } = await sb
      .from('quendify_users')
      .insert([{
        full_name: full_name.trim(),
        email: safeEmail,
        phone: whatsapp.trim(),
        whatsapp: whatsapp.trim(),
        password_hash,
        iban_holder: iban_holder.trim(),
        iban_try: iban_try.trim(),
        reception_number: reception_number.trim(),
        country: 'Turquie',
        email_verified: true
      }])
      .select('id, full_name, email, phone, whatsapp, iban_holder, iban_try, reception_number, country, email_verified, created_at')
      .single()

    if (insertError || !user) {
      return new Response(JSON.stringify({ error: 'Erreur lors de la création du compte' }), {
        status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    const token = await signToken(String(user.id), user.email, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    return new Response(JSON.stringify({ user, token }), {
      status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }
    })

  } catch (_e) {
    return new Response(JSON.stringify({ error: 'Erreur serveur' }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  }
})
