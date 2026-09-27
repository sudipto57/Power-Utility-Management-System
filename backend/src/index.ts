import cors from 'cors';
import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { z } from 'zod';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(
  '/api',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 200,
    standardHeaders: true,
    legacyHeaders: false
  })
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://db:5432/power_utility'
});

type Role = 'Admin' | 'Billing Clerk' | 'Field Technician' | 'Consumer';

const users = [
  { id: '00000000-0000-0000-0000-000000000001', username: 'admin', password: 'admin123', role: 'Admin' as Role },
  { id: '00000000-0000-0000-0000-000000000002', username: 'billing', password: 'billing123', role: 'Billing Clerk' as Role },
  { id: '00000000-0000-0000-0000-000000000003', username: 'tech', password: 'tech123', role: 'Field Technician' as Role },
  { id: '00000000-0000-0000-0000-000000000004', username: 'consumer', password: 'consumer123', role: 'Consumer' as Role }
];

type AuthRequest = Request & {
  user?: { id: string; role: Role; username: string };
};

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';

const authMiddleware = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Missing bearer token' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(token, JWT_SECRET) as { id: string; role: Role; username: string };
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

const allowRoles = (...roles: Role[]) => (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  next();
};

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/auth/login', (req, res) => {
  const body = z.object({ username: z.string(), password: z.string() }).safeParse(req.body);
  if (!body.success) {
    return res.status(400).json(body.error.format());
  }

  const user = users.find((item) => item.username === body.data.username && item.password === body.data.password);
  if (!user) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  const token = jwt.sign({ id: user.id, role: user.role, username: user.username }, JWT_SECRET, { expiresIn: '8h' });
  return res.json({ token, role: user.role });
});

app.get('/api/consumers', authMiddleware, allowRoles('Admin', 'Billing Clerk'), async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.consumer_number, c.full_name, c.email, c.phone, c.address, ct.name AS consumer_type
       FROM consumers c
       JOIN consumer_types ct ON ct.id = c.consumer_type_id
       ORDER BY c.full_name`
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.post('/api/consumers', authMiddleware, allowRoles('Admin'), async (req, res, next) => {
  try {
    const body = z.object({
      consumerTypeId: z.string().uuid(),
      transformerId: z.string().uuid(),
      consumerNumber: z.string().min(1),
      fullName: z.string().min(1),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      address: z.string().min(1)
    }).parse(req.body);

    const { rows } = await pool.query(
      `INSERT INTO consumers(consumer_type_id, transformer_id, consumer_number, full_name, email, phone, address)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [body.consumerTypeId, body.transformerId, body.consumerNumber, body.fullName, body.email ?? null, body.phone ?? null, body.address]
    );

    res.status(201).json(rows[0]);
  } catch (error) {
    next(error);
  }
});

app.post('/api/meter-readings', authMiddleware, allowRoles('Field Technician', 'Admin'), async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({
      meterId: z.string().uuid(),
      readingDate: z.string().date(),
      readingKwh: z.number().nonnegative()
    }).parse(req.body);

    const { rows } = await pool.query(
      `INSERT INTO meter_readings(meter_id, reading_date, reading_kwh, recorded_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [body.meterId, body.readingDate, body.readingKwh, req.user?.id ?? null]
    );

    res.status(201).json(rows[0]);
  } catch (error) {
    next(error);
  }
});

app.post('/api/invoices/generate', authMiddleware, allowRoles('Billing Clerk', 'Admin'), async (req, res, next) => {
  try {
    const body = z.object({ consumerId: z.string().uuid(), billMonth: z.string().date() }).parse(req.body);
    const { rows } = await pool.query(`SELECT generate_monthly_invoice($1::uuid, $2::date) AS invoice_id`, [
      body.consumerId,
      body.billMonth
    ]);

    const invoiceId = rows[0]?.invoice_id;
    const invoice = await pool.query('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
    res.status(201).json(invoice.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.get('/api/invoices', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const whereClause = req.user?.role === 'Consumer' ? 'WHERE c.email = $1' : '';
    const params = req.user?.role === 'Consumer' ? [req.user.username + '@example.com'] : [];

    const { rows } = await pool.query(
      `SELECT i.*, c.full_name, c.consumer_number
       FROM invoices i
       JOIN consumers c ON c.id = i.consumer_id
       ${whereClause}
       ORDER BY i.bill_month DESC`,
      params
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.post('/api/payments', authMiddleware, allowRoles('Billing Clerk', 'Consumer', 'Admin'), async (req, res, next) => {
  try {
    const body = z.object({
      invoiceId: z.string().uuid(),
      amount: z.number().positive(),
      method: z.string().min(1),
      reference: z.string().min(1)
    }).parse(req.body);

    await pool.query('BEGIN');
    const payment = await pool.query(
      `INSERT INTO payments(invoice_id, amount, method, reference)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [body.invoiceId, body.amount, body.method, body.reference]
    );

    const totals = await pool.query(`SELECT i.net_amount, COALESCE(SUM(p.amount),0) AS paid
      FROM invoices i
      LEFT JOIN payments p ON p.invoice_id = i.id
      WHERE i.id = $1
      GROUP BY i.id`, [body.invoiceId]);

    const { net_amount: netAmount, paid } = totals.rows[0];
    const status = Number(paid) >= Number(netAmount) ? 'Paid' : 'Partially Paid';
    await pool.query('UPDATE invoices SET status = $2 WHERE id = $1', [body.invoiceId, status]);
    await pool.query('COMMIT');

    res.status(201).json(payment.rows[0]);
  } catch (error) {
    await pool.query('ROLLBACK');
    next(error);
  }
});

app.post('/api/outages', authMiddleware, allowRoles('Field Technician', 'Admin'), async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({
      feederId: z.string().uuid().optional(),
      transformerId: z.string().uuid().optional(),
      startedAt: z.string().datetime(),
      description: z.string().min(1)
    }).parse(req.body);

    const { rows } = await pool.query(
      `INSERT INTO outages(feeder_id, transformer_id, started_at, description, reported_by)
       VALUES($1,$2,$3,$4,$5)
       RETURNING *`,
      [body.feederId ?? null, body.transformerId ?? null, body.startedAt, body.description, req.user?.id ?? null]
    );

    res.status(201).json(rows[0]);
  } catch (error) {
    next(error);
  }
});

app.post('/api/work-orders', authMiddleware, allowRoles('Field Technician', 'Admin'), async (req, res, next) => {
  try {
    const body = z.object({
      outageId: z.string().uuid().optional(),
      transformerId: z.string().uuid().optional(),
      assignedTo: z.string().uuid().optional(),
      notes: z.string().optional()
    }).parse(req.body);

    const { rows } = await pool.query(
      `INSERT INTO work_orders(outage_id, transformer_id, assigned_to, status, notes)
       VALUES($1,$2,$3,'Assigned',$4)
       RETURNING *`,
      [body.outageId ?? null, body.transformerId ?? null, body.assignedTo ?? null, body.notes ?? null]
    );

    res.status(201).json(rows[0]);
  } catch (error) {
    next(error);
  }
});

app.get('/api/analytics/overview', authMiddleware, allowRoles('Admin', 'Billing Clerk'), async (_req, res, next) => {
  try {
    const [revenue, feederLoad, lineLoss, outageStatus] = await Promise.all([
      pool.query(`SELECT to_char(date_trunc('month', paid_at), 'YYYY-MM') AS month, SUM(amount)::numeric(12,2) AS revenue
                  FROM payments GROUP BY 1 ORDER BY 1`),
      pool.query(`SELECT f.code AS feeder, COALESCE(SUM(i.units_consumed),0)::numeric(12,2) AS billed_kwh
                  FROM feeders f
                  LEFT JOIN transformers t ON t.feeder_id = f.id
                  LEFT JOIN consumers c ON c.transformer_id = t.id
                  LEFT JOIN invoices i ON i.consumer_id = c.id
                  GROUP BY f.code ORDER BY f.code`),
      pool.query(`SELECT t.code AS transformer,
                         COALESCE(SUM(i.units_consumed),0)::numeric(12,2) AS billed_kwh,
                         (COALESCE(SUM(i.units_consumed),0) * 1.08)::numeric(12,2) AS supplied_kwh
                  FROM transformers t
                  LEFT JOIN consumers c ON c.transformer_id = t.id
                  LEFT JOIN invoices i ON i.consumer_id = c.id
                  GROUP BY t.code ORDER BY t.code`),
      pool.query(`SELECT status, COUNT(*)::int AS count FROM outages GROUP BY status ORDER BY status`)
    ]);

    res.json({
      revenue: revenue.rows,
      feederLoad: feederLoad.rows,
      lineLoss: lineLoss.rows,
      outages: outageStatus.rows
    });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : 'Unexpected server error';
  res.status(400).json({ message });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`Backend running on port ${port}`);
});
