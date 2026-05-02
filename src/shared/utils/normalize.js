function normalize(str) {
  if (!str) return '';
  let s = str.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // Remove ´`^~
  s = s.replace(/\([^)]*\)|\[[^\]]*\]/g, ''); // Remove / and []
  s = s.replace(/[^a-zA-Z0-9]/g, ''); // Keep only alphanumeric
  return s.toLowerCase();
}

module.exports = { normalize };