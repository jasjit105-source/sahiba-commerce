const { ok, preflight } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  return ok({ status: 'ok', timestamp: new Date().toISOString() });
};
