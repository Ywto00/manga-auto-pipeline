const { findBestLibraryLinkForItem } = require('../domain/find-best-library-link-for-item');

function resolveItemLibraryLink(params) {
  return findBestLibraryLinkForItem(params);
}

module.exports = {
  resolveItemLibraryLink
};
