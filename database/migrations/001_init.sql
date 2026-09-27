CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS consumer_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  subsidy_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (subsidy_percent >= 0 AND subsidy_percent <= 100)
);

CREATE TABLE IF NOT EXISTS sub_stations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  location TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feeders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_station_id UUID NOT NULL REFERENCES sub_stations(id),
  code TEXT NOT NULL UNIQUE,
  max_capacity_kw NUMERIC(12,2) NOT NULL CHECK (max_capacity_kw > 0)
);

CREATE TABLE IF NOT EXISTS transformers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feeder_id UUID NOT NULL REFERENCES feeders(id),
  code TEXT NOT NULL UNIQUE,
  rated_capacity_kva NUMERIC(12,2) NOT NULL CHECK (rated_capacity_kva > 0)
);

CREATE TABLE IF NOT EXISTS consumers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_type_id UUID NOT NULL REFERENCES consumer_types(id),
  transformer_id UUID NOT NULL REFERENCES transformers(id),
  consumer_number TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  email TEXT UNIQUE,
  phone TEXT,
  address TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Consumer' CHECK (role IN ('Admin','Billing Clerk','Field Technician','Consumer'))
);

CREATE TABLE IF NOT EXISTS meters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_id UUID NOT NULL UNIQUE REFERENCES consumers(id),
  meter_number TEXT NOT NULL UNIQUE,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive','Faulty'))
);

CREATE TABLE IF NOT EXISTS slab_tariffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_type_id UUID NOT NULL REFERENCES consumer_types(id),
  unit_from INTEGER NOT NULL CHECK (unit_from >= 0),
  unit_to INTEGER,
  rate_per_kwh NUMERIC(12,4) NOT NULL CHECK (rate_per_kwh >= 0),
  effective_from DATE NOT NULL,
  effective_to DATE,
  CHECK (unit_to IS NULL OR unit_to >= unit_from)
);

CREATE TABLE IF NOT EXISTS meter_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meter_id UUID NOT NULL REFERENCES meters(id),
  reading_date DATE NOT NULL,
  reading_kwh NUMERIC(12,2) NOT NULL CHECK (reading_kwh >= 0),
  recorded_by UUID REFERENCES consumers(id),
  is_anomaly BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (meter_id, reading_date)
);

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_id UUID NOT NULL REFERENCES consumers(id),
  bill_month DATE NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  units_consumed NUMERIC(12,2) NOT NULL CHECK (units_consumed >= 0),
  gross_amount NUMERIC(12,2) NOT NULL CHECK (gross_amount >= 0),
  subsidy_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (subsidy_amount >= 0),
  penalty_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (penalty_amount >= 0),
  net_amount NUMERIC(12,2) NOT NULL CHECK (net_amount >= 0),
  status TEXT NOT NULL DEFAULT 'Unpaid' CHECK (status IN ('Unpaid','Partially Paid','Paid','Overdue')),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  due_date DATE NOT NULL,
  UNIQUE (consumer_id, bill_month)
);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  method TEXT NOT NULL,
  reference TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS outages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feeder_id UUID REFERENCES feeders(id),
  transformer_id UUID REFERENCES transformers(id),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','In Progress','Resolved')),
  description TEXT NOT NULL,
  reported_by UUID REFERENCES consumers(id)
);

CREATE TABLE IF NOT EXISTS work_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outage_id UUID REFERENCES outages(id),
  transformer_id UUID REFERENCES transformers(id),
  assigned_to UUID REFERENCES consumers(id),
  status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Assigned','In Progress','Closed')),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS financial_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name TEXT NOT NULL,
  operation TEXT NOT NULL,
  row_id UUID NOT NULL,
  old_data JSONB,
  new_data JSONB,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION flag_reading_anomaly()
RETURNS TRIGGER AS $$
DECLARE
  prev_value NUMERIC(12,2);
  delta NUMERIC(12,2);
BEGIN
  SELECT mr.reading_kwh
  INTO prev_value
  FROM meter_readings mr
  WHERE mr.meter_id = NEW.meter_id
    AND mr.reading_date < NEW.reading_date
  ORDER BY mr.reading_date DESC
  LIMIT 1;

  IF prev_value IS NOT NULL AND prev_value > 0 THEN
    delta := ABS(NEW.reading_kwh - prev_value) / prev_value;
    IF delta > 0.5 THEN
      NEW.is_anomaly := TRUE;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_flag_reading_anomaly
BEFORE INSERT OR UPDATE OF reading_kwh ON meter_readings
FOR EACH ROW EXECUTE FUNCTION flag_reading_anomaly();

CREATE OR REPLACE FUNCTION log_financial_changes()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO financial_audit_logs(table_name, operation, row_id, old_data, new_data)
  VALUES (
    TG_TABLE_NAME,
    TG_OP,
    COALESCE(NEW.id, OLD.id),
    CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END
  );

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoices_audit
AFTER INSERT OR UPDATE OR DELETE ON invoices
FOR EACH ROW EXECUTE FUNCTION log_financial_changes();

CREATE TRIGGER trg_payments_audit
AFTER INSERT OR UPDATE OR DELETE ON payments
FOR EACH ROW EXECUTE FUNCTION log_financial_changes();

CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'financial_audit_logs is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_financial_audit_immutable
BEFORE UPDATE OR DELETE ON financial_audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

CREATE OR REPLACE FUNCTION generate_monthly_invoice(
  p_consumer_id UUID,
  p_bill_month DATE,
  p_due_date DATE DEFAULT (date_trunc('month', p_bill_month) + INTERVAL '1 month' + INTERVAL '14 days')::DATE
)
RETURNS UUID AS $$
DECLARE
  v_meter_id UUID;
  v_start_reading NUMERIC(12,2) := 0;
  v_end_reading NUMERIC(12,2) := 0;
  v_units NUMERIC(12,2);
  v_consumer_type UUID;
  v_subsidy_percent NUMERIC(5,2) := 0;
  v_gross NUMERIC(12,2) := 0;
  v_subsidy NUMERIC(12,2) := 0;
  v_penalty NUMERIC(12,2) := 0;
  v_invoice_id UUID;
  r RECORD;
BEGIN
  SELECT m.id, c.consumer_type_id, ct.subsidy_percent
    INTO v_meter_id, v_consumer_type, v_subsidy_percent
  FROM consumers c
  JOIN meters m ON m.consumer_id = c.id
  JOIN consumer_types ct ON ct.id = c.consumer_type_id
  WHERE c.id = p_consumer_id;

  IF v_meter_id IS NULL THEN
    RAISE EXCEPTION 'Consumer % does not have a meter', p_consumer_id;
  END IF;

  SELECT COALESCE(MAX(reading_kwh), 0)
    INTO v_start_reading
  FROM meter_readings
  WHERE meter_id = v_meter_id
    AND reading_date < date_trunc('month', p_bill_month)::DATE;

  SELECT COALESCE(MAX(reading_kwh), v_start_reading)
    INTO v_end_reading
  FROM meter_readings
  WHERE meter_id = v_meter_id
    AND reading_date <= (date_trunc('month', p_bill_month) + INTERVAL '1 month - 1 day')::DATE;

  v_units := GREATEST(v_end_reading - v_start_reading, 0);

  FOR r IN
    SELECT unit_from, unit_to, rate_per_kwh
    FROM slab_tariffs
    WHERE consumer_type_id = v_consumer_type
      AND effective_from <= p_bill_month
      AND (effective_to IS NULL OR effective_to >= p_bill_month)
    ORDER BY unit_from
  LOOP
    IF v_units > r.unit_from THEN
      v_gross := v_gross + (
        LEAST(v_units, COALESCE(r.unit_to::NUMERIC, v_units)) - r.unit_from
      ) * r.rate_per_kwh;
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(net_amount), 0) * 0.02
    INTO v_penalty
  FROM invoices
  WHERE consumer_id = p_consumer_id
    AND due_date < CURRENT_DATE
    AND status IN ('Unpaid','Partially Paid','Overdue');

  v_subsidy := ROUND((v_gross * v_subsidy_percent / 100.0)::NUMERIC, 2);

  INSERT INTO invoices(
    consumer_id,
    bill_month,
    period_start,
    period_end,
    units_consumed,
    gross_amount,
    subsidy_amount,
    penalty_amount,
    net_amount,
    due_date
  ) VALUES (
    p_consumer_id,
    date_trunc('month', p_bill_month)::DATE,
    date_trunc('month', p_bill_month)::DATE,
    (date_trunc('month', p_bill_month) + INTERVAL '1 month - 1 day')::DATE,
    v_units,
    ROUND(v_gross, 2),
    v_subsidy,
    ROUND(v_penalty, 2),
    ROUND(v_gross - v_subsidy + v_penalty, 2),
    p_due_date
  )
  ON CONFLICT (consumer_id, bill_month) DO UPDATE
  SET units_consumed = EXCLUDED.units_consumed,
      gross_amount = EXCLUDED.gross_amount,
      subsidy_amount = EXCLUDED.subsidy_amount,
      penalty_amount = EXCLUDED.penalty_amount,
      net_amount = EXCLUDED.net_amount,
      due_date = EXCLUDED.due_date
  RETURNING id INTO v_invoice_id;

  RETURN v_invoice_id;
END;
$$ LANGUAGE plpgsql;
