function describeError(err) {
  if (!err) return 'erro-desconhecido';
  if (err instanceof Error && err.message && String(err.message).trim()) {
    return String(err.message).trim();
  }
  if (typeof err === 'string' && err.trim()) {
    return err.trim();
  }
  if (err && typeof err === 'object') {
    const code = err.code ? String(err.code) : '';
    const msg = err.message ? String(err.message).trim() : '';
    if (msg) return msg;
    if (code) return `codigo=${code}`;
    try {
      return JSON.stringify(err);
    } catch (e) {
      return String(err);
    }
  }
  return String(err);
}

module.exports = {
  describeError
};
