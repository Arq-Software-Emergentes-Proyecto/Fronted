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
