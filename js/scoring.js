/* =============================================================================
 * A Snapshot in History — scoring
 * -----------------------------------------------------------------------------
 * Pure functions with no DOM access, so they can be unit-tested in Node:
 *   node -e "const s=require('./js/scoring.js'); console.log(s.scoreRound(...))"
 *
 * Per round (max 5,000):
 *   Location (max 2,500): great-circle distance via the Haversine formula.
 *     <= 25 km        -> 2,500
 *     >= 10,000 km    -> 0
 *     in between      -> quadratic ease-out decay: 2500 * (1 - t)^2,
 *                        where t = (d - 25) / (10000 - 25)
 *   Time (max 2,500):  2,500 - 250 * |guessYear - actualYear|, floored at 0.
 * ========================================================================== */
(function (root) {
  'use strict';

  var EARTH_RADIUS_KM = 6371.0088; // IUGG mean Earth radius

  var LOCATION_MAX = 2500;
  var TIME_MAX = 2500;
  var FULL_POINTS_KM = 25;
  var ZERO_POINTS_KM = 10000;
  var POINTS_PER_YEAR = 250;

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

  /** Location points (0–2500) for a distance in km. */
  function locationScore(distanceKm) {
    if (typeof distanceKm !== 'number' || !isFinite(distanceKm) || distanceKm < 0) return 0;
    if (distanceKm <= FULL_POINTS_KM) return LOCATION_MAX;
    if (distanceKm >= ZERO_POINTS_KM) return 0;
    var t = (distanceKm - FULL_POINTS_KM) / (ZERO_POINTS_KM - FULL_POINTS_KM);
    return Math.round(LOCATION_MAX * Math.pow(1 - t, 2));
  }

  /** Time points (0–2500) for a guessed vs. actual year. */
  function timeScore(guessYear, actualYear) {
    if (!isFinite(guessYear) || !isFinite(actualYear)) return 0;
    var diff = Math.abs(Math.round(guessYear) - Math.round(actualYear));
    return Math.max(0, TIME_MAX - POINTS_PER_YEAR * diff);
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
