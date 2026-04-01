const fs = require('fs');
const path = require('path');
const minimist = require('minimist');

const { fetchAniList } = require('./anilist');
const { fetchMAL } = require('./mal');
const { normalize } = require('./normalize');

async function main() {
  const args = minimist(process.argv.slice(2));

  if (args.h || args.help) {
    console.log('Usage: node src/index.js --user <username> [--source anilist|mal] [--out data/list.json] [--dry-run]');
    return;
  }

  const username = args.user || args.u;
  const source = (args.source || 'anilist').toLowerCase();
  const out = args.out || 'data/list.json';
  const dry = Boolean(args['dry-run']);

  if (!username) {
    console.error('Error: --user <username> is required. Example: --user MyUser');
    process.exit(1);
  }

  if (!['anilist', 'mal'].includes(source)) {
    console.error('Error: --source must be either "anilist" or "mal".');
    process.exit(1);
  }

  console.log(`Fetching list for user "${username}" from ${source}...`);

  let list = [];
  try {
    if (source === 'mal') {
      list = await fetchMAL(username);
    } else {
      list = await fetchAniList(username);
    }
  } catch (err) {
    console.error('Failed to fetch data:', err.message || err);
    process.exit(1);
  }

  const mapped = list.map(item => ({ ...item, searchKey: normalize(item.title) }));

  if (dry) {
    console.log('Dry run output (first 20 items):');
    console.log(JSON.stringify(mapped.slice(0, 20), null, 2));
    console.log(`Total items found: ${mapped.length}`);
    return;
  }

  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(mapped, null, 2), 'utf8');
    console.log(`\n✓ Saved ${mapped.length} items to: ${out}`);
  } catch (err) {
    console.error('Failed to write output file:', err.message || err);
    process.exit(1);
  }
}

main().catch(err => { console.error('Unexpected error:', err); process.exit(1); });