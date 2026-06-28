import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const { text } = await req.json()
    if (!text) return new Response(JSON.stringify({ ok: false, error: 'missing text' }), { status: 400, headers: CORS })

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    const { data: token  } = await sb.rpc('get_vault_secret', { p_name: 'TELEGRAM_BOT_TOKEN' })
    const { data: chatId } = await sb.rpc('get_vault_secret', { p_name: 'TELEGRAM_CHAT_ID' })

    if (!token || !chatId) {
      return new Response(JSON.stringify({ ok: false, error: 'secrets manquants' }), { status: 500, headers: CORS })
    }

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    })
    const data = await res.json()
    return new Response(JSON.stringify(data), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: CORS })
  }
})
