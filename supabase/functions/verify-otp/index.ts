import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { email, code } = await req.json()

    if (!email || !code) {
      return new Response(JSON.stringify({ ok: false, error: 'email et code requis' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data: otpRow } = await sb
      .from('email_otps')
      .select('id')
      .eq('email', email)
      .eq('otp', code)
      .eq('used', false)
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!otpRow) {
      return new Response(JSON.stringify({ ok: false, error: 'Code incorrect ou expiré' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    await sb.from('email_otps').update({ used: true }).eq('id', otpRow.id)

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  }
})
