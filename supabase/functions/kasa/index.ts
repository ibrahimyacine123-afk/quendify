// Kasa — finances perso / Sonsuz. Admin uniquement.
// Auth : même session que admin-query (token admin-login, haché dans admin_sessions).
// Tables kasa_* verrouillées par RLS sans policy : seule cette fonction (service role) y accède.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ALLOWED_ORIGINS = ['https://www.quendify.com', 'https://quendify.com']
const CURRENCIES = ['XOF', 'XAF', 'TRY', 'USDT', 'USD', 'EUR']
const TYPES = ['momo', 'banque', 'crypto', 'especes']
const WORLDS = ['perso', 'sonsuz']
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/
const ADVISOR_MODEL = 'claude-sonnet-5-5'

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
  if (origin && ALLOWED_ORIGINS.includes(origin)) h['Access-Control-Allow-Origin'] = origin
  return h
}
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}
class Bad extends Error {}
const str = (v: unknown, max = 60) => { const s = String(v ?? '').trim(); if (!s || s.length > max) throw new Bad('Texte invalide'); return s }
const optStr = (v: unknown, max = 80) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null }
const num = (v: unknown) => { const n = Number(v); if (!Number.isFinite(n)) throw new Bad('Nombre invalide'); return n }
const pos = (v: unknown) => { const n = num(v); if (n <= 0) throw new Bad('Le montant doit être supérieur à 0'); return n }
const oneOf = (v: unknown, list: string[]) => { const s = String(v); if (!list.includes(s)) throw new Bad('Valeur non autorisée'); return s }
const id = (v: unknown) => { const s = String(v ?? ''); if (!ID_RE.test(s)) throw new Bad('Identifiant invalide'); return s }
const day = (v: unknown) => { const s = String(v ?? ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Bad('Date invalide'); return s }
const optDay = (v: unknown) => (v ? day(v) : null)

Deno.serve(async (req: Request) => {
  const CORS = corsHeaders(req.headers.get('origin'))
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const body = await req.json()
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const token = body.admin_pass
    if (!token) return json({ error: 'Session invalide ou expirée' }, 401)
    const { data: session, error: se } = await sb.from('admin_sessions').select('id, expires_at').eq('token_hash', await sha256Hex(token)).maybeSingle()
    if (se) throw se
    if (!session || new Date(session.expires_at) <= new Date()) return json({ error: 'Session invalide ou expirée' }, 401)

    const ok = () => json({ ok: true })
    const run = async (q: PromiseLike<{ error: unknown }>) => { const { error } = await q; if (error) throw error }

    switch (body.action) {
      case 'get-all': {
        const [a, t, d, i, s] = await Promise.all([
          sb.from('kasa_accounts').select('*').order('created_at'),
          sb.from('kasa_tx').select('*').order('date', { ascending: false }).order('created_at', { ascending: false }).limit(5000),
          sb.from('kasa_debts').select('*').order('created_at'),
          sb.from('kasa_inv').select('*').order('updated_at'),
          sb.from('kasa_settings').select('*').eq('id', 1).maybeSingle(),
        ])
        const err = a.error || t.error || d.error || i.error || s.error
        if (err) throw err
        return json({ accounts: a.data, tx: t.data, debts: d.data, inv: i.data, settings: s.data })
      }

      case 'add-account': {
        await run(sb.from('kasa_accounts').insert([{
          id: id(body.id), name: str(body.name), type: oneOf(body.type, TYPES), currency: oneOf(body.currency, CURRENCIES),
          world: oneOf(body.world, WORLDS), balance: num(body.balance ?? 0), checked_at: new Date().toISOString(),
        }]))
        return ok()
      }
      case 'update-account': {
        await run(sb.from('kasa_accounts').update({ name: str(body.name), type: oneOf(body.type, TYPES), world: oneOf(body.world, WORLDS) }).eq('id', id(body.id)))
        return ok()
      }
      case 'delete-account': {
        const { count } = await sb.from('kasa_tx').select('id', { count: 'exact', head: true }).or(`account_id.eq.${id(body.id)},to_account_id.eq.${id(body.id)}`)
        if ((count ?? 0) > 0) return json({ error: 'Ce compte a des opérations. Supprime-les d\'abord, ou garde le compte à 0.' }, 400)
        await run(sb.from('kasa_accounts').delete().eq('id', id(body.id)))
        return ok()
      }

      case 'add-tx': {
        const p = {
          id: id(body.id), type: oneOf(body.type, ['depense', 'revenu', 'transfert']), amount: pos(body.amount),
          account_id: id(body.account_id), to_account_id: body.to_account_id ? id(body.to_account_id) : null,
          amount_in: body.amount_in != null && body.amount_in !== '' ? pos(body.amount_in) : null,
          category: optStr(body.category, 40), note: optStr(body.note, 80), date: day(body.date), base: num(body.base ?? 0),
        }
        await run(sb.rpc('kasa_add_tx', { p }))
        return ok()
      }
      case 'delete-tx': { await run(sb.rpc('kasa_delete_tx', { p_id: id(body.id) })); return ok() }
      case 'check': {
        if (!Array.isArray(body.items) || body.items.length > 100) throw new Bad('Pointage invalide')
        const items = body.items.map((x: Record<string, unknown>) => ({
          account_id: id(x.account_id), real: x.real == null || x.real === '' ? null : num(x.real), base: num(x.base ?? 0),
        }))
        await run(sb.rpc('kasa_check', { items }))
        return ok()
      }

      case 'add-debt': {
        await run(sb.from('kasa_debts').insert([{
          id: id(body.id), direction: oneOf(body.direction, ['in', 'out']), person: str(body.person), amount: pos(body.amount),
          currency: oneOf(body.currency, CURRENCIES), due: optDay(body.due), world: oneOf(body.world, WORLDS), note: optStr(body.note),
        }]))
        return ok()
      }
      case 'settle-debt': {
        await run(sb.from('kasa_debts').update({ settled: true, settled_at: new Date().toISOString() }).eq('id', id(body.id)))
        return ok()
      }

      case 'add-inv': {
        const invested = pos(body.invested)
        await run(sb.from('kasa_inv').insert([{
          id: id(body.id), name: str(body.name), kind: str(body.kind, 30), currency: oneOf(body.currency, CURRENCIES),
          invested, value: body.value == null || body.value === '' ? invested : num(body.value),
        }]))
        return ok()
      }
      case 'update-inv': {
        await run(sb.from('kasa_inv').update({ value: num(body.value), updated_at: new Date().toISOString() }).eq('id', id(body.id)))
        return ok()
      }
      case 'delete-inv': { await run(sb.from('kasa_inv').delete().eq('id', id(body.id))); return ok() }

      case 'save-settings': {
        const r = body.rates || {}
        const rates: Record<string, number> = { USDT: 1 }
        for (const c of ['XOF', 'XAF', 'TRY', 'EUR', 'USD']) rates[c] = pos(r[c])
        const budgets: Record<string, number> = {}
        for (const [k, v] of Object.entries(body.budgets || {})) { if (k.length <= 40 && Number(v) > 0) budgets[k] = Number(v) }
        await run(sb.from('kasa_settings').upsert({ id: 1, rates, rates_at: new Date().toISOString(), budgets }))
        return ok()
      }

      case 'advise': {
        const key = Deno.env.get('ANTHROPIC_API_KEY')
        if (!key) return json({ error: 'Conseiller non configuré : ajoute le secret ANTHROPIC_API_KEY dans Supabase.' }, 503)
        const system = String(body.system || '').slice(0, 8000)
        const turns = (Array.isArray(body.turns) ? body.turns : []).slice(-12)
          .filter((m: Record<string, unknown>) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
          .map((m: Record<string, string>) => ({ role: m.role, content: m.content.slice(0, 60000) }))
        if (!turns.length || turns[0].role !== 'user' || turns[turns.length - 1].role !== 'user') throw new Bad('Conversation invalide')
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: ADVISOR_MODEL, max_tokens: 1500, system, messages: turns }),
        })
        const d = await r.json()
        if (!r.ok) return json({ error: 'Le conseiller n\'a pas répondu (' + (d?.error?.type || r.status) + ').' }, 502)
        const text = (d.content || []).filter((c: Record<string, unknown>) => c.type === 'text').map((c: Record<string, string>) => c.text).join('\n').trim()
        return json({ text, truncated: d.stop_reason === 'max_tokens' })
      }

      default:
        return json({ error: 'Action inconnue' }, 400)
    }
  } catch (e) {
    if (e instanceof Bad) return json({ error: e.message }, 400)
    const msg = (e as { message?: string })?.message || String(e)
    return json({ error: msg }, 500)
  }
})
