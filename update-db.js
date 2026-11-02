const fs = require('fs');
const dbPath = './server/db.json';

try {
  const data = fs.readFileSync(dbPath, 'utf8');
  const db = JSON.parse(data);

  if (!db.receipts) {
    db.receipts = [];
  }

  if (!db.financeSettings) {
    db.financeSettings = {
      baseMonthlyExpense: 150.00,
      lateFeeRate: 0.05
    };
  }

  if (db.users) {
    db.users.forEach(user => {
      if (user.role === 'resident' && !user.admissionDate) {
        // Set a random admission date in the past for realistic data
        const today = new Date();
        const start = new Date('2024-01-01');
        const randomDate = new Date(start.getTime() + Math.random() * (today.getTime() - start.getTime()));
        user.admissionDate = randomDate.toISOString().split('T')[0];
      }
    });
  }

  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
  console.log('db.json successfully updated for finances context.');
} catch (error) {
  console.error('Error updating db.json:', error);
}
