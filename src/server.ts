import express, { Request, Response } from 'express';
import cors from 'cors';
import { z } from 'zod';
import { getTransactions, upsertTransaction } from './database';

const app = express();
app.use(cors());
app.use(express.json());


const postbackSchema = z.object({
  transaction_id: z.string().trim().min(1, 'transaction_id é obrigatório'),
  product_name: z.string().trim().min(1, 'product_name é obrigatório'),
  customer_email: z.string().trim().email('customer_email deve ser um e-mail válido'),
  amount: z.number().positive('amount deve ser um número maior que zero'),
  currency: z.string().trim().length(3).toUpperCase().default('BRL'),
  status: z.enum(['pending', 'approved', 'refunded', 'chargeback', 'canceled']),
  payment_method: z
    .enum(['pix', 'credit_card', 'boleto'])
    .default('credit_card'),
  occurred_at: z
    .string()
    .datetime({ message: 'occurred_at deve estar no formato ISO 8601 (ex: 2026-10-26T15:00:00Z)' })
    .optional(),
});


function centsToCurrency(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'TWR Postback Receiver API',
    status: 'online',
    endpoints: {
      receive_postback: 'POST /postbacks',
      sales_report: 'GET /sales/report',
    },
  });
});

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});


app.post('/postbacks', (req: Request, res: Response) => {
  const parsed = postbackSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: 'Payload de postback inválido',
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const data = parsed.data;
  const amount_cents = Math.round(data.amount * 100);
  const occurred_at = data.occurred_at || new Date().toISOString();

  try {
    const result = upsertTransaction({
      transaction_id: data.transaction_id,
      product_name: data.product_name,
      customer_email: data.customer_email,
      amount_cents,
      currency: data.currency,
      status: data.status,
      payment_method: data.payment_method,
      occurred_at,
    });

    const statusCode = result.action === 'created' ? 201 : 200;

    return res.status(statusCode).json({
      message: 'Postback processado com sucesso',
      resolution: result.action,
      data: {
        ...result.transaction,
        amount: centsToCurrency(result.transaction.amount_cents),
      },
    });
  } catch (error) {
    console.error('Erro ao processar postback:', error);
    return res.status(500).json({ error: 'Erro interno ao processar postback' });
  }
});


app.get('/sales/report', (req: Request, res: Response) => {
  const { status, product_name, start_date, end_date } = req.query;

  const transactions = getTransactions({
    status: typeof status === 'string' ? status : undefined,
    product_name: typeof product_name === 'string' ? product_name : undefined,
    start_date: typeof start_date === 'string' ? start_date : undefined,
    end_date: typeof end_date === 'string' ? end_date : undefined,
  });

  let approvedCents = 0;
  let pendingCents = 0;
  let refundedOrChargebackCents = 0;
  let approvedCount = 0;

  const byStatus: Record<string, { count: number; total_amount: number }> = {
    approved: { count: 0, total_amount: 0 },
    pending: { count: 0, total_amount: 0 },
    refunded: { count: 0, total_amount: 0 },
    chargeback: { count: 0, total_amount: 0 },
    canceled: { count: 0, total_amount: 0 },
  };

  const productMap: Record<string, { approved_sales: number; approved_revenue_cents: number }> = {};

  for (const tx of transactions) {
    if (byStatus[tx.status]) {
      byStatus[tx.status].count += 1;
      byStatus[tx.status].total_amount = centsToCurrency(
        Math.round(byStatus[tx.status].total_amount * 100) + tx.amount_cents
      );
    }

    if (tx.status === 'approved') {
      approvedCents += tx.amount_cents;
      approvedCount += 1;

      if (!productMap[tx.product_name]) {
        productMap[tx.product_name] = { approved_sales: 0, approved_revenue_cents: 0 };
      }
      productMap[tx.product_name].approved_sales += 1;
      productMap[tx.product_name].approved_revenue_cents += tx.amount_cents;
    } else if (tx.status === 'pending') {
      pendingCents += tx.amount_cents;
    } else if (tx.status === 'refunded' || tx.status === 'chargeback') {
      refundedOrChargebackCents += tx.amount_cents;
    }
  }

  const byProduct = Object.entries(productMap).map(([product, metrics]) => ({
    product_name: product,
    approved_sales: metrics.approved_sales,
    approved_revenue: centsToCurrency(metrics.approved_revenue_cents),
  }));

  const averageTicketCents = approvedCount > 0 ? Math.round(approvedCents / approvedCount) : 0;

  return res.status(200).json({
    generated_at: new Date().toISOString(),
    summary: {
      total_transactions: transactions.length,
      approved_sales_count: approvedCount,
      net_approved_revenue: centsToCurrency(approvedCents),
      pending_revenue: centsToCurrency(pendingCents),
      lost_to_refunds_and_chargebacks: centsToCurrency(refundedOrChargebackCents),
      average_ticket: centsToCurrency(averageTicketCents),
    },
    breakdown_by_status: byStatus,
    breakdown_by_product: byProduct,
    transactions: transactions.map((tx) => ({
      transaction_id: tx.transaction_id,
      product_name: tx.product_name,
      customer_email: tx.customer_email,
      amount: centsToCurrency(tx.amount_cents),
      currency: tx.currency,
      status: tx.status,
      payment_method: tx.payment_method,
      occurred_at: tx.occurred_at,
      updated_at: tx.updated_at,
    })),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});