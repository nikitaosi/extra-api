import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';
import { randomUUID } from 'node:crypto';
import {
  AuthService,
  Currency,
  ExpenseService,
} from '../gen/extra/v1/expense_pb.js';
import { clearSessionCookie, login, logout, requireUser, setSessionCookie } from './auth.js';
import type { Database } from './db.js';
import { isUuid, validateExpenseInput } from './validation.js';

type ExpenseRow = {
  id: string;
  amount_minor: string;
  currency: 'GEL' | 'USD';
  occurred_at: Date;
  description: string;
  category_id: string;
  category_name: string;
};

const expenseColumns = `e.id, e.amount_minor, e.currency, e.occurred_at,
  e.description, c.id AS category_id, c.name AS category_name`;

function expenseFromRow(row: ExpenseRow) {
  return {
    id: row.id,
    amountMinor: BigInt(row.amount_minor),
    currency: row.currency === 'GEL' ? Currency.GEL : Currency.USD,
    occurredAt: timestampFromDate(new Date(row.occurred_at)),
    description: row.description,
    category: { id: row.category_id, name: row.category_name },
  };
}

async function getExpense(db: Database, userId: string, id: string) {
  const result = await db.query<ExpenseRow>(
    `SELECT ${expenseColumns} FROM expenses e JOIN categories c ON c.id = e.category_id
     WHERE e.user_id = $1 AND e.id = $2`, [userId, id],
  );
  const row = result.rows[0];
  if (!row) throw new ConnectError('Expense not found', Code.NotFound);
  return expenseFromRow(row);
}

async function ensureCategory(db: Database, id: string) {
  const result = await db.query('SELECT 1 FROM categories WHERE id = $1', [id]);
  if (result.rowCount === 0) throw new ConnectError('Category not found', Code.InvalidArgument);
}

export function createRoutes(db: Database, secureCookies: boolean) {
  return (router: ConnectRouter) => {
    router.service(AuthService, {
      async login(request, context) {
        if (!request.email || !request.password || request.password.length > 1024) {
          throw new ConnectError('Email and password required', Code.InvalidArgument);
        }
        const user = await login(db, request.email, request.password);
        setSessionCookie(context.responseHeader, user.token, secureCookies);
        return { email: user.email };
      },
      async logout(_request, context) {
        await logout(db, context);
        clearSessionCookie(context.responseHeader, secureCookies);
        return {};
      },
      async me(_request, context) {
        const user = await requireUser(db, context);
        return { email: user.email };
      },
    });

    router.service(ExpenseService, {
      async listCategories(_request, context) {
        await requireUser(db, context);
        const result = await db.query<{ id: string; name: string }>('SELECT id, name FROM categories ORDER BY name');
        return { categories: result.rows };
      },
      async listExpenses(request, context) {
        const user = await requireUser(db, context);
        const page = request.page || 1;
        const pageSize = request.pageSize || 20;
        if (page > 10_000 || pageSize > 100 || request.query.length > 100) {
          throw new ConnectError('Invalid pagination or query', Code.InvalidArgument);
        }
        if (request.categoryId && !isUuid(request.categoryId)) {
          throw new ConnectError('Invalid category', Code.InvalidArgument);
        }
        const filters = `e.user_id = $1 AND ($2::uuid IS NULL OR e.category_id = $2::uuid)
          AND ($3::text = '' OR e.description ILIKE $3 ESCAPE '!')`;
        const query = request.query.trim().replace(/[!%_]/g, '!$&');
        const params = [user.id, request.categoryId || null, query ? `%${query}%` : ''];
        const [rows, count] = await Promise.all([
          db.query<ExpenseRow>(
            `SELECT ${expenseColumns} FROM expenses e JOIN categories c ON c.id = e.category_id
             WHERE ${filters} ORDER BY e.occurred_at DESC, e.id DESC LIMIT $4 OFFSET $5`,
            [...params, pageSize, (page - 1) * pageSize],
          ),
          db.query<{ total: string }>(`SELECT count(*) AS total FROM expenses e WHERE ${filters}`, params),
        ]);
        return { expenses: rows.rows.map(expenseFromRow), total: Number(count.rows[0]?.total ?? 0) };
      },
      async getExpense(request, context) {
        const user = await requireUser(db, context);
        if (!isUuid(request.id)) throw new ConnectError('Invalid expense ID', Code.InvalidArgument);
        return { expense: await getExpense(db, user.id, request.id) };
      },
      async createExpense(request, context) {
        const user = await requireUser(db, context);
        const input = validateExpenseInput(request.input);
        await ensureCategory(db, input.categoryId);
        const id = randomUUID();
        await db.query(
          `INSERT INTO expenses (id, user_id, amount_minor, currency, occurred_at, description, category_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, user.id, input.amountMinor.toString(), input.currency, input.occurredAt, input.description, input.categoryId],
        );
        return { expense: await getExpense(db, user.id, id) };
      },
      async updateExpense(request, context) {
        const user = await requireUser(db, context);
        if (!isUuid(request.id)) throw new ConnectError('Invalid expense ID', Code.InvalidArgument);
        const input = validateExpenseInput(request.input);
        await ensureCategory(db, input.categoryId);
        const result = await db.query(
          `UPDATE expenses SET amount_minor = $3, currency = $4, occurred_at = $5,
           description = $6, category_id = $7, updated_at = now()
           WHERE user_id = $1 AND id = $2`,
          [user.id, request.id, input.amountMinor.toString(), input.currency, input.occurredAt, input.description, input.categoryId],
        );
        if (result.rowCount === 0) throw new ConnectError('Expense not found', Code.NotFound);
        return { expense: await getExpense(db, user.id, request.id) };
      },
      async deleteExpense(request, context) {
        const user = await requireUser(db, context);
        if (!isUuid(request.id)) throw new ConnectError('Invalid expense ID', Code.InvalidArgument);
        const result = await db.query('DELETE FROM expenses WHERE user_id = $1 AND id = $2', [user.id, request.id]);
        if (result.rowCount === 0) throw new ConnectError('Expense not found', Code.NotFound);
        return {};
      },
    });
  };
}
