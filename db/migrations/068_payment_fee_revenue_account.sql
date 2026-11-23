-- Customer surcharge revenue is distinct from actual provider expense6423.
DO $account$
BEGIN
  IF EXISTS (SELECT 1 FROM accounting.accounts WHERE code='5113'
    AND (type <> 'revenue' OR NOT is_active OR name <> 'Doanh thu phí thanh toán')) THEN
    RAISE EXCEPTION 'Payment fee revenue account5113 conflicts with the existing chart';
  END IF;
  INSERT INTO accounting.accounts(code,name,type)
    VALUES('5113','Doanh thu phí thanh toán','revenue') ON CONFLICT(code) DO NOTHING;
END;
$account$;
