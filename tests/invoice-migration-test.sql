begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);

do $$
declare
  owner_one constant uuid := '00000000-0000-0000-0000-000000000001';
  record_id constant uuid := '20000000-0000-0000-0000-000000000001';
  legacy_id constant uuid := '10000000-0000-0000-0000-000000000001';
  product constant jsonb := '{"verified":true,"kind":"Product","supplier":"Supplier","reference":"Inv / 01","amount":7442,"gst":1135.22,"gstin":"27ABCDE1234F1Z5"}';
  fee constant jsonb := '{"verified":true,"kind":"Fee","supplier":"Fee Vendor","reference":"FEE-01","amount":56,"gst":8.54,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}';
  row_record public.purchases;
  material_entry public.material_purchases;
begin
  select * into strict row_record from public.purchases where id=legacy_id;
  assert row_record.actual_payment is null and row_record.invoice_revision=0 and row_record.qty=10
    and row_record.invoice_details->0->>'reference'='OLD-1', 'legacy purchase changed';
  begin
    insert into public.equipment_purchases(supplier,invoice) values ('old supplier','old-1');
    raise exception 'Legacy duplicate was accepted';
  exception when unique_violation then null;
  end;
  update public.purchases set invoice_details='[{"verified":true,"kind":"Product","supplier":"Old Supplier","reference":"OLD-1","amount":1000,"gst":0}]' where id=legacy_id;
  insert into public.purchases(id,qty,rate,actual_payment,invoice_details)
    values (record_id,4,100,8721,jsonb_build_array(product));
  update public.purchases set invoice_details=invoice_details||jsonb_build_array(fee)
    where id=record_id and invoice_revision=0;
  select * into strict row_record from public.purchases where id=record_id;
  assert row_record.actual_payment=8721 and row_record.invoice_revision=1 and row_record.qty=4
    and row_record.rate=100 and jsonb_array_length(row_record.invoice_details)=2,'append changed purchase amounts or stock';
  update public.purchases set actual_payment=1 where id=record_id and invoice_revision=0;
  assert not found,'stale update succeeded';
  assert (select count(*)=2 from public.purchases),'invoice append inserted a purchase';

  begin
    insert into public.equipment_purchases(invoice_details)
      values (jsonb_build_array(product || '{"supplier":" supplier ","reference":"inv/01","gstin":""}'));
    raise exception 'Cross-category supplier duplicate was accepted';
  exception when unique_violation then null;
  end;
  begin
    insert into public.equipment_purchases(invoice_details)
      values (jsonb_build_array(product || '{"supplier":"Alternate supplier"}'));
    raise exception 'GSTIN duplicate was accepted';
  exception when unique_violation then null;
  end;
  begin
    insert into public.equipment_purchases(invoice_details)
      values (jsonb_build_array(fee || '{"reference":"Different ref"}'));
    raise exception 'File hash duplicate was accepted';
  exception when unique_violation then null;
  end;
  begin
    insert into public.equipment_purchases(invoice_details) values (jsonb_build_array(product || '{"gst":9000}'));
    raise exception 'Invalid GST was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.equipment_purchases(invoice_details) values
      (jsonb_build_array(product || '{"path":"00000000-0000-0000-0000-000000000002/private.pdf"}'));
    raise exception 'Other owner storage path was accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.record_material_purchase(jsonb_build_object(
      'invoice_details',jsonb_build_array(product),'id',gen_random_uuid()),'Orphan','Ink','ml');
    raise exception 'Duplicate material purchase was accepted';
  exception when unique_violation then null;
  end;
  assert not exists (select from public.materials where name='Orphan'),'duplicate purchase created material';
  material_entry := public.record_material_purchase(jsonb_build_object(
    'id',gen_random_uuid(),'actual_payment',100,'qty',1,'invoice_details','[]'::jsonb),'Ink X','Ink','ml');
  assert material_entry.owner_id=owner_one and material_entry.material_id is not null,'material purchase not created';

  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
  assert not exists(select from public.purchases where id=record_id),'purchase leaked across owners';
  update public.purchases set actual_payment=1 where id=record_id;
  assert not found,'another owner updated the purchase';
  insert into public.equipment_purchases(invoice_details) values (jsonb_build_array(product,fee));
  delete from public.equipment_purchases where owner_id=auth.uid();
  insert into public.equipment_purchases(invoice_details) values (jsonb_build_array(product,fee));
  begin
    perform * from seller_invoice_private.invoice_keys;
    raise exception 'Private registry readable by authenticated seller';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;
