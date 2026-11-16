/**
 * Canonical external links for Jin. Update checks and UI affordances point at
 * the project's GitHub Releases page so users always land on the official
 * download and changelog.
 */

export const REPO_OWNER = "ZYF93";
export const REPO_NAME = "Jin";

/** Human-facing repository URL. */
export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;

/** Human-facing releases page. */
export const RELEASES_URL = `${REPO_URL}/releases`;

/**
 * Default update feed. electron-builder publishes `latest*.yml` updater
 * metadata to GitHub Releases; `/releases/latest/download` serves those files,
 * so update checks are pinned to the official releases.
 */
export const RELEASES_FEED_URL = `${REPO_URL}/releases/latest/download`;
