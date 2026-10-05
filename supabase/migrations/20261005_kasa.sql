-- Kasa : tableau de bord finances perso / Sonsuz (admin uniquement)
-- Nouvelles tables isolées, préfixe kasa_. Ne touche à AUCUNE table existante.
-- Accès : RLS activée SANS policy => seule la service role (Edge Function kasa) lit/écrit.

create table public.kasa_accounts (
  id          text primary key,
  name        text not null check (length(name) between 1 and 60),
  type        text not null check (type in ('momo','banque','crypto','especes')),
  currency    text not null check (currency in ('XOF','XAF','TRY','USDT','USD','EUR')),
  world       text not null check (world in ('perso','sonsuz')),
  balance     numeric not null default 0,
  checked_at  timestamptz,
  created_at  timestamptz not null default now()
);

create table public.kasa_tx (
  id             text primary key,
  type           text not null check (type in ('depense','revenu','transfert','ajustement')),
  amount         numeric not null,
  currency       text not null,
  account_id     text not null references public.kasa_accounts(id),
  to_account_id  text references public.kasa_accounts(id),
  amount_in      numeric,
  to_currency    text,
  category       text,
  note           text,
  date           date not null,
  world          text,
  from_world     text,
  to_world       text,
  base           numeric not null default 0, -- valeur en USDT au moment de la saisie
  created_at     timestamptz not null default now()
);
create index kasa_tx_date_idx on public.kasa_tx(date);

create table public.kasa_debts (
  id          text primary key,
  direction   text not null check (direction in ('in','out')),
  person      text not null check (length(person) between 1 and 60),
  amount      numeric not null check (amount > 0),
  currency    text not null check (currency in ('XOF','XAF','TRY','USDT','USD','EUR')),
  due         date,
  world       text not null default 'perso' check (world in ('perso','sonsuz')),
  note        text,
  settled     boolean not null default false,
  settled_at  timestamptz,
  created_at  timestamptz not null default now()
);

create table public.kasa_inv (
  id          text primary key,
  name        text not null check (length(name) between 1 and 60),
  kind        text not null,
  currency    text not null check (currency in ('XOF','XAF','TRY','USDT','USD','EUR')),
  invested    numeric not null check (invested > 0),
  value       numeric not null,
  world       text not null default 'perso' check (world in ('perso','sonsuz')),
  updated_at  timestamptz not null default now()
);

create table public.kasa_settings (
  id        int primary key default 1 check (id = 1),
  rates     jsonb not null,
  rates_at  timestamptz,
  budgets   jsonb not null default '{}'::jsonb
);
insert into public.kasa_settings (id, rates, rates_at)
values (1, '{"USDT":1,"USD":1,"EUR":0.893,"XOF":586,"XAF":586,"TRY":49.16}', now());

alter table public.kasa_accounts enable row level security;
alter table public.kasa_tx       enable row level security;
alter table public.kasa_debts    enable row level security;
alter table public.kasa_inv      enable row level security;
alter table public.kasa_settings enable row level security;
revoke all on public.kasa_accounts, public.kasa_tx, public.kasa_debts, public.kasa_inv, public.kasa_settings from anon, authenticated;

-- Opération + mise à jour des soldes dans UNE transaction (jamais de solde à moitié écrit)
create or replace function public.kasa_add_tx(p jsonb) returns void
language plpgsql set search_path = public as $$
declare
  a kasa_accounts; b kasa_accounts;
  amt numeric := (p->>'amount')::numeric;
  amt_in numeric;
begin
  if amt is null or amt <= 0 then raise exception 'Montant invalide'; end if;
  select * into a from kasa_accounts where id = p->>'account_id' for update;
  if not found then raise exception 'Compte introuvable'; end if;

  if p->>'type' = 'transfert' then
    select * into b from kasa_accounts where id = p->>'to_account_id' for update;
    if not found or b.id = a.id then raise exception 'Compte destinataire invalide'; end if;
    amt_in := case when b.currency = a.currency then amt else (p->>'amount_in')::numeric end;
    if amt_in is null or amt_in <= 0 then raise exception 'Montant reçu invalide'; end if;
    insert into kasa_tx (id, type, amount, currency, account_id, to_account_id, amount_in, to_currency, note, date, world, from_world, to_world, base)
    values (p->>'id', 'transfert', amt, a.currency, a.id, b.id, amt_in, b.currency, nullif(p->>'note',''), (p->>'date')::date, a.world, a.world, b.world, coalesce((p->>'base')::numeric, 0));
    update kasa_accounts set balance = balance - amt    where id = a.id;
    update kasa_accounts set balance = balance + amt_in where id = b.id;
  elsif p->>'type' in ('depense','revenu') then
    if coalesce(p->>'category','') = '' then raise exception 'Catégorie requise'; end if;
    insert into kasa_tx (id, type, amount, currency, account_id, category, note, date, world, base)
    values (p->>'id', p->>'type', amt, a.currency, a.id, p->>'category', nullif(p->>'note',''), (p->>'date')::date, a.world, coalesce((p->>'base')::numeric, 0));
    update kasa_accounts set balance = balance + (case when p->>'type' = 'depense' then -amt else amt end) where id = a.id;
  else
    raise exception 'Type invalide';
  end if;
end $$;

-- Suppression d'une opération : annule son effet sur les soldes
create or replace function public.kasa_delete_tx(p_id text) returns void
language plpgsql set search_path = public as $$
declare t kasa_tx;
begin
  select * into t from kasa_tx where id = p_id for update;
  if not found then raise exception 'Opération introuvable'; end if;
  if t.type = 'transfert' then
    update kasa_accounts set balance = balance + t.amount    where id = t.account_id;
    update kasa_accounts set balance = balance - t.amount_in where id = t.to_account_id;
  elsif t.type = 'depense' then
    update kasa_accounts set balance = balance + t.amount where id = t.account_id;
  else -- revenu ou ajustement (montant signé)
    update kasa_accounts set balance = balance - t.amount where id = t.account_id;
  end if;
  delete from kasa_tx where id = p_id;
end $$;

-- Pointage : items = [{account_id, real (null = inchangé), base}]
create or replace function public.kasa_check(items jsonb) returns void
language plpgsql set search_path = public as $$
declare it jsonb; a kasa_accounts; real_bal numeric; diff numeric;
begin
  for it in select * from jsonb_array_elements(items) loop
    select * into a from kasa_accounts where id = it->>'account_id' for update;
    if not found then continue; end if;
    real_bal := (it->>'real')::numeric;
    if real_bal is not null then
      diff := real_bal - a.balance;
      if diff <> 0 then
        insert into kasa_tx (id, type, amount, currency, account_id, category, date, world, base)
        values (gen_random_uuid()::text, 'ajustement', diff, a.currency, a.id, 'Ajustement', current_date, a.world, coalesce((it->>'base')::numeric, 0));
      end if;
      update kasa_accounts set balance = real_bal, checked_at = now() where id = a.id;
    else
      update kasa_accounts set checked_at = now() where id = a.id;
    end if;
  end loop;
end $$;

revoke all on function public.kasa_add_tx(jsonb), public.kasa_delete_tx(text), public.kasa_check(jsonb) from public, anon, authenticated;
grant execute on function public.kasa_add_tx(jsonb), public.kasa_delete_tx(text), public.kasa_check(jsonb) to service_role;
