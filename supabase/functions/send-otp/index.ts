import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')

serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { email, name } = await req.json()

    if (!email) {
      return new Response(JSON.stringify({ error: 'email requis' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const arr = new Uint32Array(1)
    crypto.getRandomValues(arr)
    const otp = (10000000 + (arr[0] % 90000000)).toString()
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString()

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    const { error: dbErr } = await sb.from('email_otps').insert([{ email, otp, expires_at: expires }])
    if (dbErr) {
      return new Response(JSON.stringify({ error: dbErr.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const payload = {
      from: 'Quendify <noreply@quendify.com>',
      to: [email],
      subject: 'Votre code Quendify',
      html: `
        <div style="background:#0B2E33;padding:40px 20px;font-family:sans-serif;">
          <div style="max-width:420px;margin:0 auto;">
            <h1 style="color:#C9A227;font-size:28px;letter-spacing:4px;margin-bottom:8px;">QUENDIFY</h1>
            <p style="color:rgba(243,234,216,.6);font-size:11px;letter-spacing:3px;text-transform:uppercase;margin-bottom:32px;">Transferts membre</p>
            <p style="color:#F3EAD8;font-size:15px;margin-bottom:24px;">Bonjour${name ? ' ' + name : ''},</p>
            <p style="color:rgba(243,234,216,.7);font-size:14px;margin-bottom:28px;">Voici votre code de vérification :</p>
            <div style="background:#14474E;border:1px solid rgba(201,162,39,.3);border-radius:12px;padding:28px;text-align:center;margin-bottom:24px;">
              <div style="font-family:monospace;font-size:42px;font-weight:700;letter-spacing:12px;color:#E5C766;">${otp}</div>
            </div>
            <p style="color:rgba(243,234,216,.5);font-size:12px;margin-bottom:32px;">Valable 10 minutes. Ne partagez jamais ce code.</p>
            <a href="https://quendify.com/acces.html" style="display:inline-block;background:#C9A227;color:#0B2E33;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">Entrer mon code →</a>
          </div>
        </div>
      `
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })

    const data = await res.json()
    if (!res.ok) {
      return new Response(JSON.stringify({ error: data }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
