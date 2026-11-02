/** Receipt kinds (API: "monthly" | "extra"). */
export const ReceiptKinds = Object.freeze({ MONTHLY: 'monthly', EXTRA: 'extra' })

/**
 * Mirrors the API's ReceiptKind.Resolve: explicit kind wins (case-insensitive); otherwise a
 * receipt with no fee (amount 0) but extra charges is an extra-charge receipt.
 */
export function resolveReceiptKind(kind, amount, extraCharges) {
  const raw = String(kind ?? '').trim().toLowerCase()
  if (raw === ReceiptKinds.EXTRA) return ReceiptKinds.EXTRA
  if (raw === ReceiptKinds.MONTHLY) return ReceiptKinds.MONTHLY
  return Number(amount) === 0 && Number(extraCharges) > 0 ? ReceiptKinds.EXTRA : ReceiptKinds.MONTHLY
}

/** Extra-charge receipts never count as (or collide with) the month's maintenance fee. */
export function isExtraReceipt(row) {
  return resolveReceiptKind(row?.kind, row?.amount, row?.extraCharges) === ReceiptKinds.EXTRA
}

export class Receipt {
  constructor({
    id = null,
    residentId,
    issueDate,
    dueDate,
    amount,
    status = 'Pending',
    lateFee = 0,
    extraCharges = 0,
    billingMonth = '',
    paymentOpen = '',
    kind = '',
  }) {
    this.id = id;
    this.residentId = residentId;
    this.issueDate = issueDate;
    this.dueDate = Receipt.normalizeYmd(dueDate);
    this.amount = amount;
    this.status = status; // 'Pending', 'Paid', 'Overdue'
    this.lateFee = lateFee;
    this.extraCharges = Number(extraCharges) || 0;
    this.billingMonth = billingMonth || '';
    this.paymentOpen = Receipt.normalizeYmd(paymentOpen);
    this.kind = resolveReceiptKind(kind, amount, extraCharges);
  }

  static normalizeYmd(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return raw;
    const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) return isoMatch[1];
    const parsed = new Date(raw);
    if (!Number.isFinite(parsed.getTime())) return raw;
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  isOverdue() {
    const today = new Date();
    const dueDate = new Date(this.dueDate);
    return this.status === 'Pending' && today > dueDate;
  }

  getTotalAmount() {
    return this.amount + this.lateFee + (Number(this.extraCharges) || 0);
  }
}
