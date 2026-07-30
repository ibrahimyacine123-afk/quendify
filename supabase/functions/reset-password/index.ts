import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { email, otp_code, new_password } = await req.json()

    if (!email || !otp_code || !new_password) {
      return new Response(JSON.stringify({ error: 'Champs manquants.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (new_password.length < 8) {
      return new Response(JSON.stringify({ error: 'Le mot de passe doit contenir au moins 8 caractères.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const safeEmail = email.trim().toLocaleLowerCase('en-US')

    const { data: otpRow, error: otpErr } = await sb
      .from('email_otps')
      .select('id')
      .eq('email', safeEmail)
      .eq('otp', otp_code)
      .eq('purpose', 'password_reset')
      .eq('used', false)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()

    if (otpErr || !otpRow) {
      return new Response(JSON.stringify({ error: 'Code invalide ou expiré.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const password_hash = await hashPassword(new_password)

    const { data: updatedUsers, error: updErr } = await sb
      .from('quendify_users')
      .update({ password_hash })
      .eq('email', safeEmail)
      .select('id')

    if (updErr || !updatedUsers || updatedUsers.length === 0) {
      return new Response(JSON.stringify({ error: 'Code invalide ou expiré.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    await sb.from('email_otps').update({ used: true }).eq('id', otpRow.id)

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (_err) {
    return new Response(JSON.stringify({ error: 'Erreur interne.' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
