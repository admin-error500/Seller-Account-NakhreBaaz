-- Minimal replica of the purchase, material and owner policy contracts in Seller Hub.
create role anon;
create role authenticated;
create schema auth;
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated;

create table public.materials (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null default auth.uid(),
  name text, category text, unit text, created_at timestamptz default now()
);
create table public.purchases (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null default auth.uid(),
  product_id uuid, qty numeric, rate numeric, supplier text, invoice text, invoice_path text,
  purchased_on date default current_date, created_at timestamptz default now(),
  gst_rate numeric default 0, gst_inclusive boolean default false,
  invoice_details jsonb default '[]', purchase_discount numeric default 0, rewards_used numeric default 0,
  purchase_platform text, purchase_order_id text
);
create table public.material_purchases (like public.purchases including all);
alter table public.material_purchases drop column product_id, drop column invoice_path,
  add column material_id uuid not null references public.materials;
create table public.equipment_purchases (like public.purchases including all);
alter table public.equipment_purchases drop column product_id, drop column invoice_path, add column name text;
do $$
declare table_name text;
begin
  foreach table_name in array array['purchases','material_purchases','equipment_purchases','materials'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('grant select, insert, update, delete on public.%I to authenticated', table_name);
    execute format('create policy owner_rows on public.%I for all to authenticated using (owner_id=auth.uid()) with check (owner_id=auth.uid())', table_name);
  end loop;
end $$;

insert into purchases (id, owner_id, supplier, invoice, qty, rate, invoice_details)
values ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Old Supplier','OLD-1',10,100,
  '[{"kind":"Product","reference":"OLD-1","amount":0,"gst":0}]');
-- Historical duplicates must survive migration and continue to reserve the invoice.
insert into equipment_purchases (owner_id, supplier, invoice)
values ('00000000-0000-0000-0000-000000000001','Old Supplier','OLD-1');
