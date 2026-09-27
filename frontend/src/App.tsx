import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { jsPDF } from 'jspdf';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';

type Invoice = {
  id: string;
  bill_month: string;
  units_consumed: string;
  net_amount: string;
  status: string;
};

type Analytics = {
  revenue: Array<{ month: string; revenue: number }>;
  feederLoad: Array<{ feeder: string; billed_kwh: number }>;
  lineLoss: Array<{ transformer: string; billed_kwh: number; supplied_kwh: number }>;
  outages: Array<{ status: string; count: number }>;
};

const api = axios.create({ baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:4000' });

function App() {
  const [token, setToken] = useState('');
  const [role, setRole] = useState('');
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [analytics, setAnalytics] = useState<Analytics>({ revenue: [], feederLoad: [], lineLoss: [], outages: [] });
  const [paymentInvoiceId, setPaymentInvoiceId] = useState('');

  const authHeaders = useMemo(() => ({ Authorization: 'Bearer ' + token }), [token]);

  useEffect(() => {
    if (!token) return;
    api.get('/api/invoices', { headers: authHeaders }).then((res) => setInvoices(res.data)).catch(() => undefined);
    if (role === 'Admin' || role === 'Billing Clerk') {
      api.get('/api/analytics/overview', { headers: authHeaders }).then((res) => setAnalytics(res.data)).catch(() => undefined);
    }
  }, [token, role, authHeaders]);

  const login = async (username: string, password: string) => {
    const res = await api.post('/api/auth/login', { username, password });
    setToken(res.data.token);
    setRole(res.data.role);
  };

  const downloadPdf = (invoice: Invoice) => {
    const doc = new jsPDF();
    doc.text('Power Utility Invoice', 15, 20);
    doc.text(`Invoice ID: ${invoice.id}`, 15, 30);
    doc.text(`Bill Month: ${invoice.bill_month}`, 15, 40);
    doc.text(`Units: ${invoice.units_consumed} kWh`, 15, 50);
    doc.text(`Amount Due: ₹${invoice.net_amount}`, 15, 60);
    doc.text(`Status: ${invoice.status}`, 15, 70);
    doc.save(`invoice-${invoice.bill_month}.pdf`);
  };

  const submitPayment = async () => {
    await api.post(
      '/api/payments',
      { invoiceId: paymentInvoiceId, amount: 100, method: 'Online', reference: `txn-${Date.now()}` },
      { headers: authHeaders }
    );
    const updated = await api.get('/api/invoices', { headers: authHeaders });
    setInvoices(updated.data);
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <h1 className="text-2xl font-bold text-slate-800">Power Utility Management Portal</h1>

      {!token && (
        <div className="grid gap-2 rounded bg-white p-4 shadow">
          <p className="text-sm text-slate-600">Demo login: admin/admin123, billing/billing123, tech/tech123, consumer/consumer123</p>
          <div className="flex gap-2">
            <button className="rounded bg-blue-600 px-3 py-2 text-white" onClick={() => login('consumer', 'consumer123')}>Consumer</button>
            <button className="rounded bg-indigo-600 px-3 py-2 text-white" onClick={() => login('billing', 'billing123')}>Billing Clerk</button>
            <button className="rounded bg-emerald-600 px-3 py-2 text-white" onClick={() => login('admin', 'admin123')}>Admin</button>
          </div>
        </div>
      )}

      {token && (
        <>
          <section className="rounded bg-white p-4 shadow">
            <h2 className="mb-3 text-lg font-semibold">Consumer Portal</h2>
            <div className="space-y-2">
              {invoices.map((invoice) => (
                <div key={invoice.id} className="flex items-center justify-between rounded border p-2">
                  <span>{invoice.bill_month} | {invoice.units_consumed} kWh | ₹{invoice.net_amount} | {invoice.status}</span>
                  <button className="rounded bg-slate-700 px-3 py-1 text-white" onClick={() => downloadPdf(invoice)}>Download PDF</button>
                </div>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <input
                className="w-full rounded border px-2 py-1"
                placeholder="Invoice UUID for payment"
                value={paymentInvoiceId}
                onChange={(e) => setPaymentInvoiceId(e.target.value)}
              />
              <button className="rounded bg-green-600 px-3 py-1 text-white" onClick={submitPayment}>Pay Online</button>
            </div>
          </section>

          {(role === 'Admin' || role === 'Billing Clerk') && (
            <section className="grid gap-4 rounded bg-white p-4 shadow md:grid-cols-2">
              <h2 className="md:col-span-2 text-lg font-semibold">Admin & Analytics Dashboard</h2>

              <div className="h-64">
                <p className="font-medium">Revenue Trend</p>
                <ResponsiveContainer>
                  <LineChart data={analytics.revenue}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="month" />
                    <YAxis />
                    <Tooltip />
                    <Line type="monotone" dataKey="revenue" stroke="#2563eb" />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="h-64">
                <p className="font-medium">Feeder Load Profile</p>
                <ResponsiveContainer>
                  <BarChart data={analytics.feederLoad}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="feeder" />
                    <YAxis />
                    <Tooltip />
                    <Bar dataKey="billed_kwh" fill="#16a34a" />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="h-64">
                <p className="font-medium">Transformer Line Loss (Supplied vs Billed)</p>
                <ResponsiveContainer>
                  <BarChart data={analytics.lineLoss}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="transformer" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="supplied_kwh" fill="#f59e0b" />
                    <Bar dataKey="billed_kwh" fill="#0ea5e9" />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="h-64">
                <p className="font-medium">Outage Dispatch Status</p>
                <ResponsiveContainer>
                  <PieChart>
                    <Tooltip />
                    <Pie data={analytics.outages} dataKey="count" nameKey="status" fill="#7c3aed" />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

export default App;
