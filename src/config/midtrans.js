const axios = require('axios');

const isMidtransProduction = process.env.MIDTRANS_IS_PRODUCTION === 'true'
  || (process.env.MIDTRANS_IS_PRODUCTION == null && process.env.NODE_ENV === 'production');

const MIDTRANS_BASE = isMidtransProduction
  ? 'https://api.midtrans.com'
  : 'https://api.sandbox.midtrans.com';

const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;
const MIDTRANS_CLIENT_KEY = process.env.MIDTRANS_CLIENT_KEY;

console.log('[Midtrans] Base URL:', MIDTRANS_BASE);
console.log('[Midtrans] serverKey length:', MIDTRANS_SERVER_KEY ? MIDTRANS_SERVER_KEY.length : 'UNDEFINED');
console.log('[Midtrans] serverKey prefix:', MIDTRANS_SERVER_KEY ? MIDTRANS_SERVER_KEY.substring(0, 15) + '...' : 'UNDEFINED');
console.log('[Midtrans] clientKey length:', MIDTRANS_CLIENT_KEY ? MIDTRANS_CLIENT_KEY.length : 'UNDEFINED');

const getMidtransAuth = () => ({ auth: { username: MIDTRANS_SERVER_KEY, password: '' } });

async function getMidtransTransactionStatus(orderId) {
  const { data } = await axios.get(`${MIDTRANS_BASE}/v2/${orderId}/status`, getMidtransAuth());
  return data;
}

async function cancelMidtransTransaction(orderId) {
  return axios.post(`${MIDTRANS_BASE}/v2/${orderId}/cancel`, {}, getMidtransAuth());
}

async function refundMidtransTransaction(orderId, reason) {
  const payload = {
    refund_key: `refund-${orderId}-${Date.now()}`,
  };
  if (reason) payload.reason = reason;
  return axios.post(`${MIDTRANS_BASE}/v2/${orderId}/refund`, payload, getMidtransAuth());
}

async function reverseMidtransTransaction(orderId, reason) {
  const status = await getMidtransTransactionStatus(orderId);
  const txStatus = status.transaction_status;

  if (['refund', 'partial_refund', 'cancel', 'deny', 'expire'].includes(txStatus)) {
    return {
      action: txStatus === 'refund' ? 'refunded' : txStatus,
      status,
    };
  }

  if (['capture', 'settlement'].includes(txStatus)) {
    const response = await refundMidtransTransaction(orderId, reason);
    return { action: 'refunded', status, response: response.data };
  }

  const response = await cancelMidtransTransaction(orderId);
  return { action: 'cancelled', status, response: response.data };
}

module.exports = {
  MIDTRANS_BASE,
  MIDTRANS_SERVER_KEY,
  MIDTRANS_CLIENT_KEY,
  getMidtransAuth,
  getMidtransTransactionStatus,
  cancelMidtransTransaction,
  refundMidtransTransaction,
  reverseMidtransTransaction,
};
