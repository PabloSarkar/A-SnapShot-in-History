/* =============================================================================
 * The Daily Dose — sign-in page (signin.html)
 * Username + password only. Uses js/account.js, which talks to /api.
 * ?mode=signup opens on "Create account".
 * ========================================================================== */
(function () {
  'use strict';

  var acct = window.SnapshotAccount;
  function $(id) { return document.getElementById(id); }

  var el = {
    signedOut: $('auth-signed-out'), signedIn: $('auth-signed-in'), unavailable: $('auth-unavailable'),
    title: $('auth-title'), lede: $('auth-lede'), form: $('auth-form'),
    user: $('auth-user'), pass: $('auth-pass'), pass2: $('auth-pass2'), pass2Wrap: $('auth-pass2-wrap'),
    hint: $('auth-hint'), error: $('auth-error'), submit: $('auth-submit'),
    name: $('auth-name'), signout: $('auth-signout')
  };
  var mode = /[?&]mode=signup\b/.test(location.search) ? 'signup' : 'signin';

  function setMode(next) {
    mode = next;
    var signup = mode === 'signup';
    el.title.textContent = signup ? 'Create an account' : 'Welcome back';
    el.lede.textContent = signup ? 'Just a username and password. No email.' : 'Sign in to keep your progress.';
    el.submit.textContent = signup ? 'Create account' : 'Sign in';
    el.pass2Wrap.hidden = !signup;
    el.hint.hidden = !signup;
    el.pass.setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
    Array.prototype.forEach.call(document.querySelectorAll('[role=tab]'), function (t) {
      t.setAttribute('aria-selected', String(t.dataset.mode === mode));
    });
    showError('');
  }

  function showError(msg, field) {
    el.error.textContent = msg || '';
    [el.user, el.pass, el.pass2].forEach(function (i) { i.removeAttribute('aria-invalid'); });
    if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
  }

  function render(user) {
    var available = acct.isAvailable();
    el.signedIn.hidden = !user;
    el.signedOut.hidden = !!user;
    el.unavailable.hidden = available !== false || !!user;
    // Nothing to submit to if accounts aren't switched on.
    Array.prototype.forEach.call(el.form.elements, function (f) { f.disabled = available === false; });
    if (user) el.name.textContent = user.username;
  }

  function submit(e) {
    e.preventDefault();
    var username = el.user.value.trim();
    var password = el.pass.value;
    var signup = mode === 'signup';

    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
      return showError(signup ? 'Usernames are 3–20 characters: letters, numbers and _ only.' : 'Enter your username.', el.user);
    }
    if (password.length < 8) {
      return showError(signup ? 'Passwords need at least 8 characters.' : 'Enter your password.', el.pass);
    }
    if (signup && password !== el.pass2.value) {
      return showError('The passwords don’t match.', el.pass2);
    }

    showError('');
    el.submit.disabled = true;
    el.submit.textContent = signup ? 'Creating account…' : 'Signing in…';
    (signup ? acct.signUp(username, password) : acct.signIn(username, password))
      .then(function () {
        location.href = './';
      }, function (err) {
        var field =
          err.code === 'username_taken' || err.code === 'bad_username' ? el.user :
          err.code === 'bad_password' || err.code === 'bad_credentials' ? el.pass : null;
        showError(
          err.status === 503 || err.status === 404 ? 'Accounts aren’t switched on for this site yet.' :
          err.message || 'Something went wrong. Please try again.',
          field
        );
        el.submit.disabled = false;
        el.submit.textContent = signup ? 'Create account' : 'Sign in';
      });
  }

  Array.prototype.forEach.call(document.querySelectorAll('[role=tab]'), function (t) {
    t.addEventListener('click', function () { setMode(t.dataset.mode); el.user.focus(); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.auth-show'), function (b) {
    b.addEventListener('click', function () {
      var input = $(b.dataset.for);
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.textContent = show ? 'Hide' : 'Show';
      b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  });
  el.form.addEventListener('submit', submit);
  el.signout.addEventListener('click', function () {
    el.signout.disabled = true;
    acct.signOut().then(function () {
      el.signout.disabled = false;
      setMode('signin');
      render(null);
      el.user.focus();
    });
  });

  setMode(mode);
  acct.init().then(function (user) {
    render(user);
    if (!user && acct.isAvailable() !== false) el.user.focus();
  });
})();
