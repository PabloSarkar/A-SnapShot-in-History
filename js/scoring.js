/* =============================================================================
 * A Snapshot in History — scoring
 * -----------------------------------------------------------------------------
 * Pure functions with no DOM access, so they can be unit-tested in Node:
 *   node -e "const s=require('./js/scoring.js'); console.log(s.scoreRound(...))"
 *
 * Per round: up to 5,000 for location + 5,000 for date = 10,000.
 *
 * LOCATION (great-circle distance via the Haversine formula), in 1,000 km
 * bands. Points per km lost shrink in each band, and there's a step down at
 * each band boundary, so 1,001 km scores noticeably less than 999 km:
 *        0 –   500 km   5000 − 2·d        (rises smoothly to a perfect 5,000)
 *      500 – 1,000 km   4500 − d          (~1 pt/km)
 *    1,000 – 2,000 km   3500 − d/2        (~0.5 pt/km; 3,000 at 1,000 km)
 *    2,000 – 3,000 km   2500 − d/3        (~0.33 pt/km)
 *    3,000 – 4,000 km   1500 − d/5        (~0.2 pt/km; 700 at 4,000 km)
 *   beyond 4,000 km     keeps losing 1/6, 1/7, 1/8 … pt/km per 1,000 km band,
 *                       continuously from 700, reaching 0 at ~9,600 km.
 *
 * DATE (years off, x):
 *    0          5000
 *    1 – 5      −42.857·x² − 2.8571·x + 4990   (4944, 4813, 4596, 4293, 3904)
 *    6 – 7      3400
 *    8 – 10     2500
 *   11 – 15     2000
 *   16 – 20     1000
 *   over 20     0
 * ========================================================================== */
(function (root) {
  'use strict';

  var EARTH_RADIUS_KM = 6371.0088; // IUGG mean Earth radius

  var LOCATION_MAX = 5000;
  var TIME_MAX = 5000;

  /*
   * Location bands: [upper bound in km, start value at d = 0, points lost per km].
   * Score inside a band = start − perKm · d. Edit these to retune.
   */
  var DISTANCE_BANDS = [
    [500, 5000, 2],
    [1000, 4500, 1],
    [2000, 3500, 1 / 2],
    [3000, 2500, 1 / 3],
    [4000, 1500, 1 / 5]
  ];

  /* Date bands beyond the first five years: [max years off, points]. */
  var DATE_STEPS = [
    [7, 3400],
    [10, 2500],
    [15, 2000],
    [20, 1000]
  ];

  function toRad(deg) {
    return (deg * Math.PI) / 180;
  }

  /** Great-circle distance between two lat/lng points, in kilometres. */
  function haversineKm(lat1, lng1, lat2, lng2) {
    var dLat = toRad(lat2 - lat1);
    var dLng = toRad(lng2 - lng1);
    var a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
    return EARTH_RADIUS_KM * c;
  }

  /** Location points (0–5000) for a distance in km. */
  function locationScore(d) {
    if (typeof d !== 'number' || !isFinite(d) || d < 0) return 0;
    for (var i = 0; i < DISTANCE_BANDS.length; i++) {
      var b = DISTANCE_BANDS[i];
      if (d < b[0]) return clampScore(b[1] - b[2] * d, LOCATION_MAX);
    }
    // Past the last band: carry on from its end value, losing 1/6, 1/7, 1/8 …
    // points per km in each further 1,000 km band, until the score hits 0.
    var last = DISTANCE_BANDS[DISTANCE_BANDS.length - 1];
    var edge = last[0];
    var score = last[1] - last[2] * edge;       // 700 at 4,000 km
    for (var n = 6; score > 0; n++) {
      var perKm = 1 / n;
      if (d < edge + 1000) return clampScore(score - perKm * (d - edge), LOCATION_MAX);
      score -= perKm * 1000;
      edge += 1000;
    }
    return 0;
  }

  /** Date points (0–5000) for a guessed vs. actual year. */
  function timeScore(guessYear, actualYear) {
    if (!isFinite(guessYear) || !isFinite(actualYear)) return 0;
    var x = Math.abs(Math.round(guessYear) - Math.round(actualYear));
    if (x === 0) return TIME_MAX;
    if (x <= 5) return clampScore(-42.857 * x * x - 2.8571 * x + 4990, TIME_MAX);
    for (var i = 0; i < DATE_STEPS.length; i++) {
      if (x <= DATE_STEPS[i][0]) return DATE_STEPS[i][1];
    }
    return 0;
  }

  function clampScore(v, max) {
    return Math.max(0, Math.min(max, Math.round(v)));
  }

  /** Full breakdown for one round. */
  function scoreRound(guess, actual) {
    var distanceKm = haversineKm(guess.lat, guess.lng, actual.lat, actual.lng);
    var yearDiff = Math.abs(Math.round(guess.year) - Math.round(actual.year));
    var loc = locationScore(distanceKm);
    var time = timeScore(guess.year, actual.year);
    return {
      distanceKm: distanceKm,
      yearDiff: yearDiff,
      locationScore: loc,
      timeScore: time,
      total: loc + time
    };
  }

  var api = {
    EARTH_RADIUS_KM: EARTH_RADIUS_KM,
    LOCATION_MAX: LOCATION_MAX,
    TIME_MAX: TIME_MAX,
    ROUND_MAX: LOCATION_MAX + TIME_MAX,
    DISTANCE_BANDS: DISTANCE_BANDS,
    DATE_STEPS: DATE_STEPS,
    haversineKm: haversineKm,
    locationScore: locationScore,
    timeScore: timeScore,
    scoreRound: scoreRound
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.SnapshotScoring = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
