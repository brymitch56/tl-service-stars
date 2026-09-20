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

/**
 * The award grid's Program column, per star level — and the same words the
 * trailman picker uses as its optgroup labels on /advancement/index.
 */
const PROGRAM_OF = { Navigator: 'Navigators', Adventurer: 'Adventurers' };

/**
 * Trailman-picker optgroup label -> star level.
 *
 * The picker groups people by their LEVEL ASSIGNMENT, which is the thing that
 * decides whether someone can still earn a star. It is not a youth/adult
 * split: a Trailman who turns 18 becomes a registered adult but keeps his
 * Adventurers level, and keeps earning stars until that level is removed. The
 * portal's own grouping is therefore the authority, and anything outside these
 * two groups (its 'Adult' group, for one) earns nothing.
 */
const LEVEL_BY_GROUP = Object.fromEntries(
  Object.entries(PROGRAM_OF).map(([level, group]) => [group.toLowerCase(), level]),
);
const starLevelOfGroup = (label) => LEVEL_BY_GROUP[String(label || '').trim().toLowerCase()] || null;

/**
 * The advancement form's `level-select` RADIO value. Not a level hashid —
 * the form uses short codes, and both star levels live under the same
 * Navigators/Adventurers group (the other value is 'wt', Woodlands Trail).
 */
const LEVEL_SELECT = { Navigator: 'navadv', Adventurer: 'navadv' };

/** The `level` parameter of POST /advancement/badge-tracker-view. */
const TRACKER_VIEW_LEVEL = LEVEL_SELECT;

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
  STAR_AWARD_IDS, STAR_AWARD_TITLES, LEVEL_IDS, PROGRAM_OF, LEVEL_SELECT, TRACKER_VIEW_LEVEL, LEVEL_BY_GROUP, starLevelOfGroup,
  normalizeLevel, isStarLevel, isWoodlands, starLevelOfTitle,
};
