ALTER TABLE expenses DROP CONSTRAINT expenses_currency_check;
ALTER TABLE expenses
  ADD CONSTRAINT expenses_currency_check CHECK (currency IN ('GEL', 'USD', 'THB'));
