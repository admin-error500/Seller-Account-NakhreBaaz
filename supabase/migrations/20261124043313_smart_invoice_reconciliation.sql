begin;

-- Existing payment estimates and invoice JSON stay intact until a seller verifies them.
alter table public.purchases
  add column actual_payment numeric(14,2) check (actual_payment is null or (actual_payment >= 0 and actual_payment < 'Infinity'::numeric)),
  add column invoice_revision bigint not null default 0;
alter table public.material_purchases
  add column actual_payment numeric(14,2) check (actual_payment is null or (actual_payment >= 0 and actual_payment < 'Infinity'::numeric)),
  add column invoice_revision bigint not null default 0;
alter table public.equipment_purchases
  add column actual_payment numeric(14,2) check (actual_payment is null or (actual_payment >= 0 and actual_payment < 'Infinity'::numeric)),
  add column invoice_revision bigint not null default 0;

create schema seller_invoice_private;
revoke all on schema seller_invoice_private from public, anon, authenticated;

-- Counts allow historical duplicates to remain readable while reserving their keys.
create table seller_invoice_private.invoice_keys (
  owner_id uuid not null,
  invoice_key text not null,
  occurrences bigint not null check (occurrences > 0),
  primary key (owner_id, invoice_key)
);
alter table seller_invoice_private.invoice_keys enable row level security;

create function seller_invoice_private.normalize(value text)
returns text language sql immutable strict set search_path = pg_catalog as $$
  select regexp_replace(lower(value), '[[:space:]]+', '', 'g')
$$;

create function seller_invoice_private.keys(purchase jsonb)
returns setof text language sql immutable set search_path = pg_catalog as $$
  with details as (
    select item from jsonb_array_elements(
      case when jsonb_typeof(purchase->'invoice_details') = 'array' then purchase->'invoice_details' else '[]'::jsonb end
    ) as entries(item)
  ), documents as (
    select item->>'reference' as reference, coalesce(nullif(item->>'supplier', ''), purchase->>'supplier') as supplier,
      item->>'gstin' as gstin, item->>'sha256' as file_hash
    from details
    union all
    select purchase->>'invoice', purchase->>'supplier', null, null
    where not exists (
      select 1 from details where seller_invoice_private.normalize(item->>'reference')
        = seller_invoice_private.normalize(purchase->>'invoice')
    )
  ), normalized as (
    select seller_invoice_private.normalize(reference) as reference,
      seller_invoice_private.normalize(supplier) as supplier,
      seller_invoice_private.normalize(gstin) as gstin, lower(file_hash) as file_hash
    from documents
  )
  select encode(sha256(convert_to(jsonb_build_array('supplier', supplier, reference)::text, 'UTF8')), 'hex') from normalized where supplier <> '' and reference <> ''
  union all
  select encode(sha256(convert_to(jsonb_build_array('gstin', gstin, reference)::text, 'UTF8')), 'hex') from normalized where gstin <> '' and reference <> ''
  union all
  select encode(sha256(convert_to(jsonb_build_array('file', file_hash)::text, 'UTF8')), 'hex') from normalized where file_hash <> '';
$$;

-- The ALTER TABLE locks above also prevent purchase writes during this backfill.
insert into seller_invoice_private.invoice_keys (owner_id, invoice_key, occurrences)
select owner_id, invoice_key, count(*)
from (
  select owner_id, to_jsonb(p) as purchase from public.purchases p
  union all
  select owner_id, to_jsonb(p) from public.material_purchases p
  union all
  select owner_id, to_jsonb(p) from public.equipment_purchases p
) purchases
cross join lateral seller_invoice_private.keys(purchase) as keys(invoice_key)
where owner_id is not null
group by owner_id, invoice_key;

-- The trigger only maintains the private reservation table for the RLS-checked parent write.
create function seller_invoice_private.sync_purchase()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
declare
  old_purchase jsonb;
  new_purchase jsonb;
  document jsonb;
  previous_documents jsonb;
  key_change record;
  updated_count bigint;
  purchase_owner uuid;
begin
  if tg_op <> 'INSERT' then
    old_purchase := to_jsonb(old);
    purchase_owner := old.owner_id;
  end if;
  if tg_op <> 'DELETE' then
    purchase_owner := new.owner_id;
    new_purchase := to_jsonb(new);
  end if;
  if tg_op = 'INSERT' then
    new.invoice_revision := 0;
  elsif tg_op = 'UPDATE' then
    if old.owner_id is distinct from new.owner_id then
      raise exception 'Purchase ownership cannot change' using errcode = '23514';
    end if;
    new.invoice_revision := old.invoice_revision;
    if new.invoice_details is not distinct from old.invoice_details and
       new.actual_payment is not distinct from old.actual_payment and
       new.supplier is not distinct from old.supplier and new.invoice is not distinct from old.invoice then
      return new;
    end if;
    new.invoice_revision := old.invoice_revision + 1;
  end if;

  if tg_op <> 'DELETE' and new.invoice_details is distinct from old_purchase->'invoice_details' then
    if jsonb_typeof(new.invoice_details) is distinct from 'array' then
      raise exception 'Invoice details must be an array' using errcode = '23514';
    end if;
    previous_documents := case when jsonb_typeof(old_purchase->'invoice_details') = 'array'
      then old_purchase->'invoice_details' else '[]'::jsonb end;
    for document in select value from jsonb_array_elements(new.invoice_details) loop
      if exists (
        select 1 from jsonb_array_elements(previous_documents) p(value) where p.value = document
      ) then continue;
      end if;
      if purchase_owner is null or document->'verified' is distinct from 'true'::jsonb
         or coalesce(document->>'kind', '') not in ('Product', 'Fee')
         or coalesce(seller_invoice_private.normalize(document->>'supplier'), '') = ''
         or coalesce(seller_invoice_private.normalize(document->>'reference'), '') = ''
         or char_length(document->>'supplier') > 250 or char_length(document->>'reference') > 120
         or coalesce(document->>'gstin', '') !~ '^(|[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9])$'
         or coalesce(document->>'sha256', '') !~ '^(|[a-f0-9]{64})$'
         or (document->>'path' is not null and split_part(document->>'path', '/', 1) <> purchase_owner::text)
         or jsonb_typeof(document->'amount') is distinct from 'number'
         or jsonb_typeof(document->'gst') is distinct from 'number'
      then
        raise exception 'Invalid verified purchase invoice' using errcode = '23514';
      end if;
      if (document->>'amount')::numeric < 0 or (document->>'amount')::numeric >= 1e12
         or (document->>'gst')::numeric < 0 or (document->>'gst')::numeric > (document->>'amount')::numeric
         or scale((document->>'amount')::numeric) > 2 or scale((document->>'gst')::numeric) > 2
      then
        raise exception 'Invalid purchase invoice amount or GST' using errcode = '23514';
      end if;
    end loop;
  end if;

  if purchase_owner is not null then
    for key_change in
      select key, sum(delta) as difference from (
        select key, 1 as delta from seller_invoice_private.keys(new_purchase) key
        union all
        select key, -1 as delta from seller_invoice_private.keys(old_purchase) key
      ) changes group by key having sum(delta) <> 0 order by key
    loop
      if key_change.difference > 0 then
        if key_change.difference > 1 then
          raise exception 'Duplicate invoice on this purchase' using errcode = '23505';
        end if;
        insert into seller_invoice_private.invoice_keys (owner_id, invoice_key, occurrences)
        values (purchase_owner, key_change.key, 1)
        on conflict do nothing;
        if not found then
          raise exception 'Duplicate invoice on an existing purchase' using errcode = '23505';
        end if;
      else
        select occurrences into strict updated_count from seller_invoice_private.invoice_keys
        where owner_id = purchase_owner and invoice_key = key_change.key for update;
        if updated_count = -key_change.difference then
          delete from seller_invoice_private.invoice_keys
          where owner_id = purchase_owner and invoice_key = key_change.key;
        else
          update seller_invoice_private.invoice_keys set occurrences = updated_count + key_change.difference
          where owner_id = purchase_owner and invoice_key = key_change.key;
        end if;
      end if;
    end loop;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke execute on all functions in schema seller_invoice_private from public, anon, authenticated;

create trigger sync_invoice_keys before insert or update or delete on public.purchases
for each row execute function seller_invoice_private.sync_purchase();
create trigger sync_invoice_keys before insert or update or delete on public.material_purchases
for each row execute function seller_invoice_private.sync_purchase();
create trigger sync_invoice_keys before insert or update or delete on public.equipment_purchases
for each row execute function seller_invoice_private.sync_purchase();

-- Recording a new material and its purchase is one owner-scoped transaction.
create function public.record_material_purchase(purchase jsonb, material_name text, material_category text, material_unit text)
returns public.material_purchases language plpgsql security invoker set search_path = pg_catalog as $$
declare
  seller uuid := auth.uid();
  material uuid;
  entry public.material_purchases;
begin
  if seller is null or nullif(btrim(material_name), '') is null then
    raise exception 'A signed-in seller and material name are required' using errcode = '23514';
  end if;
  entry := jsonb_populate_record(null::public.material_purchases, purchase);
  perform pg_advisory_xact_lock(hashtextextended(
    jsonb_build_array(seller, lower(btrim(material_name)), material_category, material_unit)::text, 0));
  select id into material from public.materials
  where owner_id = seller and lower(name) = lower(btrim(material_name))
    and category = material_category and unit = material_unit
  order by created_at, id limit 1;
  if material is null then
    insert into public.materials (name, category, unit)
    values (btrim(material_name), material_category, material_unit) returning id into material;
  end if;
  insert into public.material_purchases (id, material_id, qty, rate, supplier, invoice, purchased_on,
    gst_rate, gst_inclusive, invoice_details, purchase_discount, rewards_used, purchase_platform,
    purchase_order_id, actual_payment)
  values (entry.id, material, entry.qty, entry.rate, entry.supplier, entry.invoice, entry.purchased_on,
    entry.gst_rate, entry.gst_inclusive, entry.invoice_details, entry.purchase_discount, entry.rewards_used,
    entry.purchase_platform, entry.purchase_order_id, entry.actual_payment)
  returning * into entry;
  return entry;
end;
$$;
revoke execute on function public.record_material_purchase(jsonb,text,text,text) from public, anon;
grant execute on function public.record_material_purchase(jsonb,text,text,text) to authenticated;

commit;
