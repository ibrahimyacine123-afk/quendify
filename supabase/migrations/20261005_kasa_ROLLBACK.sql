-- ROLLBACK de 20261005_kasa.sql
-- Supprime uniquement les objets kasa_*. Aucune table Quendify existante n'est concernée.
-- ATTENTION : efface définitivement les données Kasa saisies.
drop function if exists public.kasa_check(jsonb);
drop function if exists public.kasa_delete_tx(text);
drop function if exists public.kasa_add_tx(jsonb);
drop table if exists public.kasa_tx;
drop table if exists public.kasa_accounts;
drop table if exists public.kasa_debts;
drop table if exists public.kasa_inv;
drop table if exists public.kasa_settings;
