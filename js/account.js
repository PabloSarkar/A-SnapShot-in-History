/* =============================================================================
 * A Snapshot in History — account client
 * Talks to /api (functions/api/[[route]].js). Everything here is optional:
 * if the API isn't there (local file, plain static host, or D1 not bound yet)
 * the game keeps working with browser-only guest progress.
 * ========================================================================== */
(function () {
  'use strict';

  var API = './api/';
  var state = {
    user: null,        // { username } when signed in
    available: null    // true / false once checked; null while unknown
  };
  var listeners = [];

  function emit() {
    listeners.forEach(function (fn) { try { fn(state.user); } catch (e) { console.error(e); } });
  }

  function request(method, path, body) {
    var init = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(API + path, init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error((data && data.message) || ('Request failed (' + res.status + ')'));
          err.status = res.status;
          err.code = data && data.error;
          throw err;
        }
        return data;
      });
    });
  }

  var initPromise = null;
  /** Check the API and whether we're already signed in. Never rejects. */
  function init() {
    if (!initPromise) {
      if (location.protocol === 'file:') {
        state.available = false;
        initPromise = Promise.resolve(null);
      } else {
        initPromise = request('GET', 'me').then(function (data) {
          state.available = true;
          state.user = data && data.user ? data.user : null;
          emit();
          return state.user;
        }, function () {
          state.available = false; // 404 (no Functions), 503 (no database) or offline
          return null;
        });
      }
    }
    return initPromise;
  }

  function signIn(username, password) {
    return request('POST', 'login', { username: username, password: password }).then(function (data) {
      state.available = true;
      state.user = data.user;
      emit();
      return state.user;
    });
  }

  function signUp(username, password) {
    return request('POST', 'signup', { username: username, password: password }).then(function (data) {
      state.available = true;
      state.user = data.user;
      emit();
      return state.user;
    });
  }

  function signOut() {
    return request('POST', 'logout', {}).catch(function () { /* signed out locally anyway */ })
      .then(function () {
        state.user = null;
        emit();
      });
  }

  function loadProgress() {
    if (!state.user) return Promise.resolve(null);
    return request('GET', 'progress').then(function (d) { return d && d.data; });
  }

  var saveTimer = null;
  var pendingSave = null;
  /** Save progress (debounced); resolves when written. Failures are logged, not thrown. */
  function saveProgress(data) {
    if (!state.user) return Promise.resolve(false);
    pendingSave = data;
    clearTimeout(saveTimer);
    return new Promise(function (resolve) {
      saveTimer = setTimeout(function () {
        var body = pendingSave;
        pendingSave = null;
        request('PUT', 'progress', { data: body }).then(function () { resolve(true); }, function (e) {
          console.warn('Could not save progress to your account', e);
          if (e.status === 401) { state.user = null; emit(); }
          resolve(false);
        });
      }, 300);
    });
  }

  window.SnapshotAccount = {
    init: init,
    signIn: signIn,
    signUp: signUp,
    signOut: signOut,
    loadProgress: loadProgress,
    saveProgress: saveProgress,
    user: function () { return state.user; },
    isAvailable: function () { return state.available; },
    onChange: function (fn) { listeners.push(fn); }
  };
})();
