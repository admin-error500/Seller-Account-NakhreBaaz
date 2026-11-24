begin;

create table public.supplier_advances (
  id uuid primary key,
  owner_id uuid not null default auth.uid(),
  supplier text not null check (char_length(btrim(supplier)) between 1 and 250),
  amount numeric not null check (amount > 0 and amount < 1e12 and scale(amount) <= 2),
  paid_on date not null,
  reference text not null default '' check (char_length(reference) <= 250),
  created_at timestamptz not null default now()
);
create index supplier_advances_owner_idx on public.supplier_advances(owner_id, created_at, id);
alter table public.supplier_advances enable row level security;
revoke all on public.supplier_advances from public, anon, authenticated;
grant select, insert on public.supplier_advances to authenticated;
create policy advance_owner_read on public.supplier_advances for select to authenticated
using (owner_id = (select auth.uid()));
create policy advance_owner_insert on public.supplier_advances for insert to authenticated
with check (owner_id = (select auth.uid()));

create table public.supplier_advance_allocations (
  id uuid primary key,
  owner_id uuid not null default auth.uid(),
  advance_id uuid not null references public.supplier_advances(id),
  purchase_id uuid references public.purchases(id) on delete cascade,
  material_purchase_id uuid references public.material_purchases(id) on delete cascade,
  equipment_purchase_id uuid references public.equipment_purchases(id) on delete cascade,
  amount numeric not null check (amount > 0 and amount < 1e12 and scale(amount) <= 2),
  created_at timestamptz not null default now(),
  check (num_nonnulls(purchase_id, material_purchase_id, equipment_purchase_id) = 1)
);
create index advance_allocations_owner_idx on public.supplier_advance_allocations(owner_id, created_at, id);
create index advance_allocations_advance_idx on public.supplier_advance_allocations(advance_id);
create index advance_allocations_purchase_idx on public.supplier_advance_allocations(purchase_id) where purchase_id is not null;
create index advance_allocations_material_idx on public.supplier_advance_allocations(material_purchase_id) where material_purchase_id is not null;
create index advance_allocations_equipment_idx on public.supplier_advance_allocations(equipment_purchase_id) where equipment_purchase_id is not null;
alter table public.supplier_advance_allocations enable row level security;
revoke all on public.supplier_advance_allocations from public, anon, authenticated;
grant select, insert on public.supplier_advance_allocations to authenticated;
create policy allocation_owner_read on public.supplier_advance_allocations for select to authenticated
using (owner_id = (select auth.uid()));
create policy allocation_owner_insert on public.supplier_advance_allocations for insert to authenticated
with check (owner_id = (select auth.uid()));

-- A due balance is eligible once the purchase has a verified product invoice.
create function seller_invoice_private.advance_bill_total(documents jsonb)
returns numeric language sql immutable set search_path = pg_catalog as $$
  select case when bool_and(coalesce(line->'verified' = 'true'::jsonb and jsonb_typeof(line->'amount') = 'number', false))
    and bool_or(line->>'kind' = 'Product')
    then sum((line->>'amount')::numeric) end
  from jsonb_array_elements(case when jsonb_typeof(documents) = 'array' then documents else '[]'::jsonb end) line
$$;

create function seller_invoice_private.purchase_advance_total(purchase_table text, target_id uuid)
returns numeric language sql stable set search_path = pg_catalog as $$
  select coalesce(sum(amount), 0) from public.supplier_advance_allocations
  where (purchase_table = 'purchases' and purchase_id = target_id)
    or (purchase_table = 'material_purchases' and material_purchase_id = target_id)
    or (purchase_table = 'equipment_purchases' and equipment_purchase_id = target_id)
$$;

-- The trigger validates ownership and serializes allocations even for direct table inserts.
create function seller_invoice_private.validate_advance_allocation()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
declare
  target record;
  advance public.supplier_advances;
  target_table text;
  target_id uuid;
  used numeric;
  bill numeric;
begin
  if auth.uid() is null or new.owner_id is distinct from auth.uid() then
    raise exception 'Advance allocation is not allowed' using errcode = '42501';
  end if;
  if num_nonnulls(new.purchase_id, new.material_purchase_id, new.equipment_purchase_id) <> 1 then
    raise exception 'Select one purchase' using errcode = '23514';
  end if;
  target_table := case when new.purchase_id is not null then 'purchases'
    when new.material_purchase_id is not null then 'material_purchases' else 'equipment_purchases' end;
  target_id := coalesce(new.purchase_id, new.material_purchase_id, new.equipment_purchase_id);
  -- Write the locked row versions so repeatable-read transactions cannot allocate against stale snapshots.
  execute format('update public.%I set actual_payment = actual_payment where id = $1 and owner_id = $2 returning supplier, actual_payment, invoice_details', target_table)
    into target using target_id, new.owner_id;
  if target.supplier is null or nullif(btrim(target.supplier), '') is null then
    raise exception 'Purchase is unavailable or has no supplier' using errcode = '23514';
  end if;
  update public.supplier_advances set amount = amount
    where id = new.advance_id and owner_id = new.owner_id returning * into advance;
  if not found then
    raise exception 'Advance is unavailable' using errcode = '23514';
  end if;
  if seller_invoice_private.normalize(advance.supplier) <> seller_invoice_private.normalize(target.supplier) then
    raise exception 'Advance and purchase must have the same supplier' using errcode = '23514';
  end if;
  bill := seller_invoice_private.advance_bill_total(target.invoice_details);
  if bill is null or target.actual_payment is null then
    raise exception 'Verify the purchase invoices and record its direct payment first' using errcode = '23514';
  end if;
  select coalesce(sum(amount), 0) into used from public.supplier_advance_allocations where advance_id = advance.id;
  if used + new.amount > advance.amount then
    raise exception 'Amount exceeds the remaining advance. Refresh and try again.' using errcode = '23514';
  end if;
  if target.actual_payment + seller_invoice_private.purchase_advance_total(target_table,target_id) + new.amount > bill then
    raise exception 'Amount exceeds the balance due on this purchase' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- Purchase edits must leave every applied advance covered by the verified bill.
create function seller_invoice_private.protect_purchase_advances()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
declare
  applied numeric;
  bill numeric;
begin
  if new.actual_payment is not distinct from old.actual_payment
    and new.invoice_details is not distinct from old.invoice_details
    and new.supplier is not distinct from old.supplier then return new; end if;
  applied := seller_invoice_private.purchase_advance_total(tg_table_name, old.id);
  if applied = 0 then return new; end if;
  bill := seller_invoice_private.advance_bill_total(new.invoice_details);
  if seller_invoice_private.normalize(old.supplier) is distinct from seller_invoice_private.normalize(new.supplier)
    or bill is null or new.actual_payment is null or new.actual_payment + applied > bill then
    raise exception 'Purchase changes would invalidate an applied supplier advance' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function seller_invoice_private.advance_bill_total(jsonb) from public, anon, authenticated;
revoke execute on function seller_invoice_private.purchase_advance_total(text,uuid) from public, anon, authenticated;
revoke execute on function seller_invoice_private.validate_advance_allocation() from public, anon, authenticated;
revoke execute on function seller_invoice_private.protect_purchase_advances() from public, anon, authenticated;
create trigger validate_advance_allocation before insert on public.supplier_advance_allocations
for each row execute function seller_invoice_private.validate_advance_allocation();
create trigger protect_purchase_advances before update on public.purchases
for each row execute function seller_invoice_private.protect_purchase_advances();
create trigger protect_purchase_advances before update on public.material_purchases
for each row execute function seller_invoice_private.protect_purchase_advances();
create trigger protect_purchase_advances before update on public.equipment_purchases
for each row execute function seller_invoice_private.protect_purchase_advances();

commit;
