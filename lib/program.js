'use strict';
/**
 * program.js — Trail Life USA program constants.
 *
 * These ids describe the PROGRAM, not any person, so they belong in git
 * (see CLAUDE.md). All were read from a live Trail Life Connect session on
 * 2026-09-19: the level ids from the `ActivitiesSearch[event_level]` filter
 * on /activities, the award ids from `#badge-select` on /advancement/index.
 */

/** Woodlands Trail levels. Their hours never count and never carry. */
const WOODLANDS_LEVELS = ['Fox', 'Hawk', 'Mountain Lion'];

/** The levels that earn Service Stars, in program order (carry flows down this list). */
const STAR_LEVELS = ['Navigator', 'Adventurer'];

/** Every level the portal can put on a service row. */
const ALL_LEVELS = [...WOODLANDS_LEVELS, ...STAR_LEVELS];

/** Hundredths of an hour per star. Navigator 15 h · Adventurer 20 h. */
const RATE_HUNDREDTHS = { Navigator: 1500, Adventurer: 2000 };

/**
 * Service Star award ids on Trail Life Connect. The awards GRID does not
 * carry these ids (unlike AHGFamily), so reads match on title + program —
 * these are for the push, which selects the award in `#badge-select`.
 */
const STAR_AWARD_IDS = { Navigator: 'acc66f374e08', Adventurer: 'acb527dc22b8' };

/** Award title exactly as the awards grid renders it, per level. */
const STAR_AWARD_TITLES = { Navigator: 'Navigator Service Star', Adventurer: 'Adventurer Service Star' };
const LEVEL_BY_STAR_TITLE = Object.fromEntries(
  Object.entries(STAR_AWARD_TITLES).map(([level, title]) => [title.toLowerCase(), level]),
);

/** Portal level ids — also the "All Navigators"/"All Adventurers" group values. */
const LEVEL_IDS = {
  Fox: 'l3c59dc048e8',
  Hawk: 'ib6d767d2f8e',
  'Mountain Lion': 'k37693cfc748',
  Navigator: 'j8e296a067a3',
  Adventurer: 'x1ff1de77400',
};

/** The `level-select` value the advancement page expects for a star level. */
const PROGRAM_OF = { Navigator: 'Navigators', Adventurer: 'Adventurers' };

/** Level label → canonical name, or null when it is not one of the five. */
function normalizeLevel(s) {
  const t = String(s || '').trim().toLowerCase();
  return ALL_LEVELS.find((l) => l.toLowerCase() === t) || null;
}

const isStarLevel = (l) => STAR_LEVELS.includes(l);
const isWoodlands = (l) => WOODLANDS_LEVELS.includes(l);

/** Award title → star level, or null. */
const starLevelOfTitle = (title) => LEVEL_BY_STAR_TITLE[String(title || '').trim().toLowerCase()] || null;

module.exports = {
  WOODLANDS_LEVELS, STAR_LEVELS, ALL_LEVELS, RATE_HUNDREDTHS,
  STAR_AWARD_IDS, STAR_AWARD_TITLES, LEVEL_IDS, PROGRAM_OF,
  normalizeLevel, isStarLevel, isWoodlands, starLevelOfTitle,
};
