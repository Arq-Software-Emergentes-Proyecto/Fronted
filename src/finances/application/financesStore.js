import { reactive, computed } from 'vue';
import { financesApi } from '../infrastructure/financesApi.js';
import { isExtraReceipt } from '../domain/receipt.js';
import {
  applyLateFeeToReceipt,
  computeChargeDates,
  currentStatementMonthKey,
  findCharge,
  latestCharge,
  nextMonthKey,
  normalizeMonthKey,
  normalizeSettings,
  residentOwesMonth,
  todayYmd,
  uniqueCharges,
} from '../domain/billingCycle.js';

const state = reactive({
  settings: null,
  residents: [],
  receipts: [],
  isLoading: false,
  error: null
});

export function useFinancesStore() {
  const loadData = async () => {
    state.isLoading = true;
    state.error = null;
    try {
      state.settings = await financesApi.getSettings();
      state.residents = await financesApi.getResidents();
      state.receipts = await financesApi.getReceipts();
      await applyDailyLateFees();
    } catch (err) {
      state.error = 'Failed to load finances data';
      console.error(err);
    } finally {
      state.isLoading = false;
    }
  };

  const currentBillingMonthKey = computed(() => {
    const settings = state.settings ? normalizeSettings(state.settings) : normalizeSettings({})
    const monthKey = currentStatementMonthKey(new Date(), settings)
    return findCharge(settings.monthlyCharges, monthKey)?.month || monthKey
  })

  const getResidentFinancialStatus = computed(() => {
    return state.residents.map(resident => {
      // Find all receipts for this resident
      const settings = state.settings ? normalizeSettings(state.settings) : normalizeSettings({})
      const todayStr = todayYmd()
      const resReceipts = state.receipts
        .filter((r) => String(r.residentId) === String(resident.id))
        .map((r) => applyLateFeeToReceipt(r, settings.lateFeePerDay, todayStr));

      const monthKey = currentBillingMonthKey.value
      const currentCharge = findCharge(settings.monthlyCharges, monthKey)
      const monthReceipt = receiptForMonth(resReceipts, monthKey)
      const owesMonth = residentOwesMonth(resident, monthKey, settings)
      const monthStatus = monthPaymentStatus(monthReceipt, currentCharge, todayStr, owesMonth)

      let nextPaymentDate = dueDateFromCharge(
        currentCharge || latestCharge(settings.monthlyCharges),
        settings,
      )
      if (!owesMonth && !monthReceipt) {
        const followingMonth = nextMonthKey(monthKey)
        nextPaymentDate = dueDateFromCharge(
          findCharge(settings.monthlyCharges, followingMonth),
          settings,
          followingMonth,
        )
      }

      if (resReceipts.length > 0) {
        const unpaidReceipts = resReceipts.filter(r => r.status !== 'Paid');

        if (unpaidReceipts.length > 0) {
          const oldestUnpaidDueDate = new Date(Math.min(...unpaidReceipts.map(r => new Date(r.dueDate))));
          if (!isNaN(oldestUnpaidDueDate.getTime())) {
            nextPaymentDate = new Date(oldestUnpaidDueDate);
          }
        } else {
          const latestReceipt = [...resReceipts].sort((a, b) =>
            String(b.billingMonth || b.dueDate).localeCompare(String(a.billingMonth || a.dueDate)),
          )[0]
          const followingMonth = nextMonthKey(
            latestReceipt.billingMonth || currentStatementMonthKey(new Date(), settings),
          )
          nextPaymentDate = dueDateFromCharge(
            findCharge(settings.monthlyCharges, followingMonth),
            settings,
            followingMonth,
          )
        }
      }

      // Calculate countdown to next expected payment
      const today = new Date();
      const timeDiff = nextPaymentDate.getTime() - today.getTime();
      const daysUntilNextPayment = Math.ceil(timeDiff / (1000 * 3600 * 24));
      // Current exact status
      // A receipt is overdue if its status is 'Overdue' OR it is 'Pending' and today's date has reached (or passed) its due date
      const hasOverdue = resReceipts.some(r =>
        isPaidStatus(r.status) === false && (
          r.status === 'Overdue' ||
          (isPendingStatus(r.status) && todayStr >= r.dueDate)
        )
      );
      const hasPending = resReceipts.some(r => isPendingStatus(r.status));

      let overallStatus = monthStatus;
      if (hasOverdue) overallStatus = 'Overdue';
      else if (resReceipts.length === 0 && daysUntilNextPayment <= 0) overallStatus = 'Overdue';
      else if (hasPending) overallStatus = 'Pending';
      else if (resReceipts.length > 0 && resReceipts.every((r) => isPaidStatus(r.status))) overallStatus = 'Paid';

      const fmtDate = (d) => {
        const y = d.getFullYear();
        const m = (d.getMonth() + 1).toString().padStart(2, '0');
        const dayDt = d.getDate().toString().padStart(2, '0');
        return `${y}-${m}-${dayDt}`;
      };

      return {
        ...resident,
        nextPaymentDate: fmtDate(nextPaymentDate),
        daysUntilNextPayment,
        overallStatus,
        monthStatus,
        currentBillingMonth: monthKey,
        currentChargeAmount: currentCharge?.amount ?? null,
        receipts: resReceipts
      };
    });
  });

  /**
   * Status of one resident's maintenance fee for any month "yyyy-MM", with the same rules as
   * `monthStatus` above (Paid | Pending | Overdue | Unbilled | Exempt). `row` is a resident,
   * optionally carrying its late-fee-applied `receipts` (as in getResidentFinancialStatus).
   */
  function residentMonthStatus(row, monthKey) {
    const settings = normalizeSettings(state.settings || {})
    const todayStr = todayYmd()
    const month = normalizeMonthKey(monthKey)
    const receipts = Array.isArray(row?.receipts)
      ? row.receipts
      : state.receipts
        .filter((r) => String(r.residentId) === String(row?.id))
        .map((r) => applyLateFeeToReceipt(r, settings.lateFeePerDay, todayStr))
    return monthPaymentStatus(
      receiptForMonth(receipts, month),
      findCharge(settings.monthlyCharges, month),
      todayStr,
      residentOwesMonth(row, month, settings),
    )
  }

  function isPaidStatus(status) {
    return status === 'Paid' || status === 'Pagado'
  }

  function isPendingStatus(status) {
    return status === 'Pending' || status === 'Pendiente'
  }

  function receiptForMonth(receipts, monthKey) {
    // Only the monthly fee receipt counts; extra-charge receipts (kind "extra") also carry a billingMonth.
    const monthly = (receipts || []).filter((receipt) => !isExtraReceipt(receipt))
    const exact = monthly.find(
      (receipt) => String(receipt.billingMonth || '') === String(monthKey),
    )
    if (exact) return exact

    const paymentMonth = nextMonthKey(monthKey)
    return monthly.find((receipt) => {
      if (receipt.billingMonth) return false
      const due = String(receipt.dueDate || '')
      return due.startsWith(paymentMonth) || due.startsWith(String(monthKey))
    }) || null
  }

  function monthPaymentStatus(receipt, charge, todayStr, owesMonth = true) {
    if (receipt) {
      if (isPaidStatus(receipt.status)) return 'Paid'
      if (
        receipt.status === 'Overdue' ||
        (isPendingStatus(receipt.status) && receipt.dueDate && todayStr >= receipt.dueDate)
      ) {
        return 'Overdue'
      }
      return 'Pending'
    }
    if (!charge) return 'Unbilled'
    if (!owesMonth) return 'Exempt'
    if (charge.paymentDue && todayStr >= charge.paymentDue) return 'Overdue'
    return 'Pending'
  }

  const applyDailyLateFees = async () => {
    const settings = normalizeSettings(state.settings || {})
    const today = todayYmd()
    const perDay = Number(settings.lateFeePerDay) || 0

    for (let i = 0; i < state.receipts.length; i++) {
      const current = state.receipts[i]
      if (isPaidStatus(current.status)) continue

      const next = applyLateFeeToReceipt(current, perDay, today)
      const sameFee = Number(current.lateFee || 0) === Number(next.lateFee || 0)
      const sameStatus = String(current.status) === String(next.status)
      if (sameFee && sameStatus) continue

      const updatedReceipt = await financesApi.updateReceipt(current.id, {
        lateFee: next.lateFee,
        status: next.status,
      })
      state.receipts[i] = applyLateFeeToReceipt(updatedReceipt, perDay, today)
    }
  }

  function dueDateFromCharge(charge, settings, monthKey) {
    const due = charge?.paymentDue || computeChargeDates(monthKey || charge?.month, settings).paymentDue
    const parsed = due ? new Date(`${due}T12:00:00`) : new Date()
    return Number.isFinite(parsed.getTime()) ? parsed : new Date()
  }

  // Utility to reliably format date strings
  const formatLocalIsoStringDate = (dateOb) => {
    const y = dateOb.getFullYear();
    const m = (dateOb.getMonth() + 1).toString().padStart(2, '0');
    const day = dateOb.getDate().toString().padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const updateSettings = async (newSettings) => {
    try {
      state.isLoading = true;
      const current = normalizeSettings(state.settings || {})
      const incoming = normalizeSettings(newSettings || {})
      const locked = new Map(
        current.monthlyCharges.map((charge) => [normalizeMonthKey(charge.month), charge]),
      )
      const merged = []
      const seen = new Set()

      for (const charge of incoming.monthlyCharges) {
        const month = normalizeMonthKey(charge.month)
        if (!month || seen.has(month)) continue
        merged.push(locked.get(month) || charge)
        seen.add(month)
      }
      for (const [month, charge] of locked) {
        if (!seen.has(month)) merged.push(charge)
      }

      const updated = await financesApi.updateSettings({
        ...incoming,
        monthlyCharges: uniqueCharges(merged),
      });
      state.settings = updated;
      await applyDailyLateFees();
      return updated;
    } catch (err) {
      console.error('Error updating finance settings:', err);
      throw new Error('Error updating finance settings');
    } finally {
      state.isLoading = false;
    }
  };

  function upsertResident(resident) {
    const id = String(resident?.id ?? '')
    if (!id) return resident
    const index = state.residents.findIndex((row) => String(row.id) === id)
    const current = index === -1 ? null : state.residents[index]
    const next = {
      ...current,
      ...resident,
      admissionDate:
        String(current?.admissionDate ?? '').trim() ||
        String(resident?.admissionDate ?? '').trim() ||
        todayYmd(),
      billFromNextMonth: Boolean(
        resident?.billFromNextMonth ?? current?.billFromNextMonth,
      ),
    }
    if (index === -1) state.residents.unshift(next)
    else state.residents[index] = { ...state.residents[index], ...next }
    return next
  }

  async function cancelUnpaidAdmissionMonthReceipt(resident) {
    const admissionMonth = normalizeMonthKey(resident?.admissionDate)
    if (!admissionMonth) return
    const residentId = String(resident?.id ?? '')
    if (!residentId) return
    const receipts = await financesApi.getReceiptsByResident(residentId).catch(() => [])
    for (const receipt of receipts) {
      if (String(receipt.status ?? '') === 'Paid') continue
      // Only the admission-month maintenance fee; extra-charge receipts stay.
      if (isExtraReceipt(receipt)) continue
      const billingMonth = normalizeMonthKey(receipt.billingMonth || receipt.dueDate)
      if (billingMonth !== admissionMonth) continue
      await financesApi.deleteReceipt(receipt.id)
      const receiptId = String(receipt.id)
      state.receipts = state.receipts.filter((row) => String(row.id) !== receiptId)
    }
  }

  const setResidentBillFromNextMonth = async (resident, billFromNextMonth) => {
    const next = upsertResident({
      ...resident,
      billFromNextMonth: Boolean(billFromNextMonth),
    })
    if (next.billFromNextMonth) {
      await cancelUnpaidAdmissionMonthReceipt(next)
      return next
    }
    await generateInitialReceipt(next)
    return next
  }

  const generateInitialReceipt = async (resident) => {
    state.settings = await financesApi.getSettings().catch(() =>
      normalizeSettings(state.settings || {}),
    )
    const settings = normalizeSettings(state.settings)
    const monthKey = currentStatementMonthKey(new Date(), settings)
    const billedResident = upsertResident(resident)
    if (!residentOwesMonth(billedResident, monthKey, settings)) return null
    const charge = findCharge(settings.monthlyCharges, monthKey)
    if (!charge) return null
    const existing = await financesApi.getReceiptsByResident(billedResident.id).catch(() => [])
    const alreadyBilled = existing.some(
      (receipt) =>
        !isExtraReceipt(receipt) &&
        normalizeMonthKey(receipt.billingMonth || receipt.dueDate) ===
        String(charge.month || monthKey),
    )
    if (alreadyBilled) return null
    const dates = charge
    const amount = Number(charge.amount || settings.baseMonthlyExpense) || 150
    const dueDate = dates.paymentDue
    const issueDate = formatLocalIsoStringDate(new Date());

    const receiptData = {
      id: Date.now(),
      residentId: billedResident.id,
      issueDate,
      dueDate,
      amount,
      status: 'Pending',
      lateFee: 0,
      billingMonth: charge?.month || monthKey,
      paymentOpen: dates.paymentOpen,
      kind: 'monthly',
    };

    try {
      const created = await financesApi.createReceipt(receiptData);
      state.receipts.push(created);
      return created;
    } catch (err) {
      console.error("Failed to generate initial receipt:", err);
      return null;
    }
  };

  /**
   * RF021 / TS003: la facturación del mes corre en el servidor (idempotente: índice único
   * owner + residente + mes). Sin cuota configurada → error MISSING_MONTHLY_CHARGE.
   * Devuelve { month, created, alreadyBilled, notDue } y recarga los recibos.
   */
  const generateMonthlyReceipts = async (monthKey) => {
    state.isLoading = true
    try {
      const result = await financesApi.generateMonthlyReceipts(monthKey)
      state.receipts = await financesApi.getReceipts()
      return result
    } catch (err) {
      if (err?.code === 'MISSING_MONTHLY_CHARGE') throw err
      console.error(err)
      const error = new Error('Error generating monthly receipts')
      error.code = err?.code || 'GENERATE_RECEIPTS_FAILED'
      throw error
    } finally {
      state.isLoading = false
    }
  };

  // US-18: Automated payment reconciliation (Mocked from Frontend)
  const simulatePaymentReconciliation = async (receiptId) => {
    try {
      state.isLoading = true;
      const updatedReceipt = await financesApi.updateReceipt(receiptId, { status: 'Paid' });
      // Update local state
      const index = state.receipts.findIndex(r => r.id === receiptId);
      if (index !== -1) {
        state.receipts[index] = updatedReceipt;
      }

      // AUTO-GENERATION HOOK: "los recibos que se emitan automáticamente solo después de que se paguen"
      // Automatically evaluate if we should issue the *next* tracking bill right away
      const r = updatedReceipt;
      const baseDueDate = new Date(r.dueDate);
      // Paying an extra-charge receipt does not roll the monthly fee forward.
      if (!isExtraReceipt(r) && !isNaN(baseDueDate.getTime())) {
        baseDueDate.setDate(baseDueDate.getDate() + 30);
        const nextDueDate = formatLocalIsoStringDate(baseDueDate);
        const issueDate = formatLocalIsoStringDate(new Date());

        if (!state.settings) {
          state.settings = await financesApi.getSettings().catch(() => normalizeSettings({}));
        }
        const settings = normalizeSettings(state.settings)
        const followingMonth = nextMonthKey(r.billingMonth || currentStatementMonthKey(new Date(), settings))
        const nextCharge = findCharge(settings.monthlyCharges, followingMonth)
        const nextDates = nextCharge || computeChargeDates(followingMonth, settings)

        const nextReceiptData = {
          id: Date.now() + Math.floor(Math.random() * 1000),
          residentId: r.residentId,
          issueDate,
          dueDate: nextDates.paymentDue || nextDueDate,
          amount: Number(nextCharge?.amount || r.amount || settings.baseMonthlyExpense) || 150,
          status: 'Pending',
          lateFee: 0,
          billingMonth: followingMonth,
          paymentOpen: nextDates.paymentOpen,
          kind: 'monthly',
        };
        const autoCreated = await financesApi.createReceipt(nextReceiptData);
        state.receipts.push(autoCreated);
      }
    } catch (err) {
      console.error(err);
      throw new Error('Error processing payment reconciliation');
    } finally {
      state.isLoading = false;
    }
  };

  const simulateNightlyCron = async () => {
    try {
      state.isLoading = true;
      if (!state.settings) {
        state.settings = await financesApi.getSettings().catch(() => normalizeSettings({}));
      }
      await applyDailyLateFees();
    } catch (err) {
      console.error(err);
      throw new Error('Error running nightly cron job');
    } finally {
      state.isLoading = false;
    }
  };

  return {
    state,
    loadData,
    currentBillingMonthKey,
    getResidentFinancialStatus,
    residentMonthStatus,
    generateInitialReceipt,
    setResidentBillFromNextMonth,
    generateMonthlyReceipts,
    simulatePaymentReconciliation,
    simulateNightlyCron,
    applyDailyLateFees,
    updateSettings
  };
}
