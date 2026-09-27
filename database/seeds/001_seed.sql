INSERT INTO consumer_types(name, subsidy_percent)
VALUES
  ('Residential', 10.00),
  ('Commercial', 0.00),
  ('Industrial', 0.00)
ON CONFLICT (name) DO NOTHING;

WITH ss AS (
  INSERT INTO sub_stations(code, name, location)
  VALUES ('SS-001', 'Central Substation', 'North Zone')
  ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
  RETURNING id
), fd AS (
  INSERT INTO feeders(sub_station_id, code, max_capacity_kw)
  SELECT id, 'FD-001', 2500 FROM ss
  ON CONFLICT (code) DO UPDATE SET max_capacity_kw = EXCLUDED.max_capacity_kw
  RETURNING id
), tx AS (
  INSERT INTO transformers(feeder_id, code, rated_capacity_kva)
  SELECT id, 'TX-001', 500 FROM fd
  ON CONFLICT (code) DO UPDATE SET rated_capacity_kva = EXCLUDED.rated_capacity_kva
  RETURNING id
), c AS (
  INSERT INTO consumers(consumer_type_id, transformer_id, consumer_number, full_name, email, address)
  SELECT ct.id, tx.id, 'CNS-0001', 'Demo Consumer', 'consumer@example.com', '123 Utility Street'
  FROM consumer_types ct, tx
  WHERE ct.name = 'Residential'
  ON CONFLICT (consumer_number) DO UPDATE SET full_name = EXCLUDED.full_name
  RETURNING id
)
INSERT INTO meters(consumer_id, meter_number)
SELECT id, 'MTR-0001' FROM c
ON CONFLICT (meter_number) DO NOTHING;

INSERT INTO slab_tariffs(consumer_type_id, unit_from, unit_to, rate_per_kwh, effective_from)
SELECT ct.id, t.unit_from, t.unit_to, t.rate_per_kwh, DATE '2025-01-01'
FROM consumer_types ct
JOIN (
  VALUES
    ('Residential', 0, 100, 4.50),
    ('Residential', 101, 300, 6.20),
    ('Residential', 301, NULL, 8.00),
    ('Commercial', 0, 200, 8.50),
    ('Commercial', 201, NULL, 10.00),
    ('Industrial', 0, NULL, 9.75)
) AS t(type_name, unit_from, unit_to, rate_per_kwh)
  ON t.type_name = ct.name;

INSERT INTO meter_readings(meter_id, reading_date, reading_kwh)
SELECT m.id, d::date, r::numeric
FROM meters m
JOIN (
  VALUES
    (DATE '2026-06-30', 1200),
    (DATE '2026-07-31', 1380),
    (DATE '2026-08-31', 1605)
) AS mr(d, r) ON TRUE
WHERE m.meter_number = 'MTR-0001'
ON CONFLICT (meter_id, reading_date) DO NOTHING;
