async function loadSuwayomiLibraryIndex(params) {
  const client = params && params.client;
  const listSources = params && params.listSources;

  let entries = [];
  let sources = [];

  try {
    const rows = await client.get('/api/v1/category/0');
    entries = Array.isArray(rows) ? rows : [];
  } catch (e) {
    entries = [];
  }

  try {
    const listed = await listSources(client);
    sources = Array.isArray(listed) ? listed : [];
  } catch (e) {
    sources = [];
  }

  const sourceNameById = new Map(sources.map(s => [String(s && s.id || ''), String(s && s.name || s && s.id || '')]));
  return { entries, sourceNameById };
}

module.exports = {
  loadSuwayomiLibraryIndex
};
