import Database from 'better-sqlite3';
import path from 'path';

const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), 'sales.db');
const db = new Database(dbPath);


db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    transaction_id TEXT PRIMARY KEY,
    product_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'BRL',
    status TEXT NOT NULL,
    payment_method TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

export type TransactionStatus = 'pending' | 'approved' | 'refunded' | 'chargeback' | 'canceled';

export interface PostbackRecord {
  transaction_id: string;
  product_name: string;
  customer_email: string;
  amount_cents: number;
  currency: string;
  status: TransactionStatus;
  payment_method: string;
  occurred_at: string;
}


const STATUS_PRIORITY: Record<TransactionStatus, number> = {
  pending: 1,
  approved: 2,
  canceled: 3,
  refunded: 3,
  chargeback: 3,
};

export function upsertTransaction(data: PostbackRecord): {
  action: 'created' | 'updated' | 'ignored_out_of_order' | 'idempotent_no_change';
  transaction: PostbackRecord;
} {
  const existing = db
    .prepare('SELECT * FROM transactions WHERE transaction_id = ?')
    .get(data.transaction_id) as (PostbackRecord & { updated_at: string }) | undefined;

  const now = new Date().toISOString();

  if (!existing) {
    db.prepare(`
      INSERT INTO transactions (
        transaction_id, product_name, customer_email, amount_cents,
        currency, status, payment_method, occurred_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.transaction_id,
      data.product_name,
      data.customer_email,
      data.amount_cents,
      data.currency,
      data.status,
      data.payment_method,
      data.occurred_at,
      now
    );

    return { action: 'created', transaction: data };
  }

  
  if (existing.status === data.status) {
    return { action: 'idempotent_no_change', transaction: existing };
  }

  
  const currentPriority = STATUS_PRIORITY[existing.status];
  const incomingPriority = STATUS_PRIORITY[data.status];

  if (incomingPriority < currentPriority) {
    return { action: 'ignored_out_of_order', transaction: existing };
  }

  
  db.prepare(`
    UPDATE transactions
    SET status = ?, amount_cents = ?, updated_at = ?
    WHERE transaction_id = ?
  `).run(data.status, data.amount_cents, now, data.transaction_id);

  return {
    action: 'updated',
    transaction: { ...existing, status: data.status, amount_cents: data.amount_cents },
  };
}

export function getTransactions(filters: {
  status?: string;
  product_name?: string;
  start_date?: string;
  end_date?: string;
}): Array<PostbackRecord & { updated_at: string }> {
  let query = 'SELECT * FROM transactions WHERE 1=1';
  const params: unknown[] = [];

  if (filters.status) {
    query += ' AND status = ?';
    params.push(filters.status);
  }
  if (filters.product_name) {
    query += ' AND product_name LIKE ?';
    params.push(`%${filters.product_name}%`);
  }
  if (filters.start_date) {
    query += ' AND occurred_at >= ?';
    params.push(filters.start_date);
  }
  if (filters.end_date) {
    query += ' AND occurred_at <= ?';
    params.push(filters.end_date);
  }

  query += ' ORDER BY occurred_at DESC';

  return db.prepare(query).all(...params) as Array<PostbackRecord & { updated_at: string }>;
}