begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);

do $$
declare
  supplier_advance constant uuid := '30000000-0000-0000-0000-000000000001';
  other_advance constant uuid := '30000000-0000-0000-0000-000000000002';
  purchase constant uuid := '40000000-0000-0000-0000-000000000001';
  other_purchase constant uuid := '40000000-0000-0000-0000-000000000002';
  invoice constant jsonb := '{"verified":true,"kind":"Product","supplier":"Acme","reference":"A-1","amount":10000,"gst":0}';
begin
  insert into public.supplier_advances(id,supplier,amount,paid_on) values
    (supplier_advance,' acme ',5000,'2026-10-12'),
    (other_advance,'Acme',15000,'2026-10-15');
  insert into public.equipment_purchases(id,supplier,qty,rate,actual_payment,invoice_details) values
    (purchase,'Acme',1,10000,0,jsonb_build_array(invoice)),
    (other_purchase,'Acme',2,5000,0,jsonb_build_array(invoice||'{"reference":"A-2"}'));
  insert into public.supplier_advance_allocations(id,advance_id,equipment_purchase_id,amount)
    values(gen_random_uuid(),supplier_advance,purchase,4000);
  assert (select qty=1 and actual_payment=0 from public.equipment_purchases where id=purchase),
    'allocation changed quantity or direct cash';
  assert (select amount=5000 from public.supplier_advances where id=supplier_advance),
    'allocation changed original cash payment';
  begin
    insert into public.supplier_advance_allocations(id,advance_id,equipment_purchase_id,amount)
      values(gen_random_uuid(),supplier_advance,other_purchase,1001);
    raise exception 'Overspent advance';
  exception when check_violation then null;
  end;
  insert into public.supplier_advance_allocations(id,advance_id,equipment_purchase_id,amount)
    values(gen_random_uuid(),supplier_advance,other_purchase,1000);
  begin
    insert into public.supplier_advance_allocations(id,advance_id,equipment_purchase_id,amount)
      values(gen_random_uuid(),other_advance,purchase,6001);
    raise exception 'Overpaid purchase';
  exception when check_violation then null;
  end;
  begin
    update public.equipment_purchases set actual_payment=6001 where id=purchase;
    raise exception 'Purchase update overpaid the invoice';
  exception when check_violation then null;
  end;
  update public.equipment_purchases set actual_payment=6000 where id=purchase;
  begin
    update public.equipment_purchases set supplier='Another supplier' where id=purchase;
    raise exception 'Purchase update left another supplier on the allocation';
  exception when check_violation then null;
  end;

  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
  assert not exists(select from public.supplier_advances where id=supplier_advance),'advance leaked to another owner';
  assert not exists(select from public.supplier_advance_allocations),'allocation leaked to another owner';
  begin
    insert into public.supplier_advance_allocations(id,advance_id,equipment_purchase_id,amount)
      values(gen_random_uuid(),supplier_advance,purchase,1);
    raise exception 'Another owner used the advance';
  exception when check_violation then null;
  end;
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
  delete from public.equipment_purchases where id=purchase;
  assert not exists(select from public.supplier_advance_allocations where equipment_purchase_id=purchase),
    'deleting a purchase did not release the allocation';
  assert (select amount=5000 from public.supplier_advances where id=supplier_advance),
    'deleting the purchase removed the recorded payment';
end $$;
rollback;
