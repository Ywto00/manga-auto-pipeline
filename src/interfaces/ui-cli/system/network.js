const os = require('os');

function getLocalIPv4Candidates() {
  const out = [];
  const nets = os.networkInterfaces();
  Object.values(nets || {}).forEach(list => {
    (list || []).forEach(addr => {
      if (!addr || addr.internal) return;
      if (addr.family !== 'IPv4') return;
      out.push(addr.address);
    });
  });
  return [...new Set(out)];
}

module.exports = {
  getLocalIPv4Candidates
};