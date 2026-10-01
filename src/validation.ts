import { Code, ConnectError } from '@connectrpc/connect';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { Currency, type ExpenseInput } from '../gen/extra/v1/expense_pb.js';

const maxAmountMinor = 999_999_999_99n;

export function validateExpenseInput(input: ExpenseInput | undefined) {
  if (!input) throw new ConnectError('Expense is required', Code.InvalidArgument);
  if (input.amountMinor <= 0n || input.amountMinor > maxAmountMinor) {
    throw new ConnectError('Amount must be positive and at most 999,999,999.99', Code.InvalidArgument);
  }
  if (input.currency !== Currency.GEL && input.currency !== Currency.USD && input.currency !== Currency.THB) {
    throw new ConnectError('Unsupported currency', Code.InvalidArgument);
  }
  if (!input.occurredAt) throw new ConnectError('Date is required', Code.InvalidArgument);
  const occurredAt = timestampDate(input.occurredAt);
  if (Number.isNaN(occurredAt.valueOf())) throw new ConnectError('Invalid date', Code.InvalidArgument);
  if (occurredAt.valueOf() > Date.now() + 86_400_000) {
    throw new ConnectError('Date cannot be more than one day in the future', Code.InvalidArgument);
  }
  const description = input.description.trim();
  if (description.length > 500) throw new ConnectError('Description is too long', Code.InvalidArgument);
  if (!isUuid(input.categoryId)) throw new ConnectError('Invalid category', Code.InvalidArgument);
  const currency = input.currency === Currency.GEL ? 'GEL' : input.currency === Currency.USD ? 'USD' : 'THB';
  return { amountMinor: input.amountMinor, currency, occurredAt, description, categoryId: input.categoryId };
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
