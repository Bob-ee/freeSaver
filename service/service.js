// Background service bundled with freeSaver.
//
// LG removes sideloaded apps when the TV's Developer Mode session runs out.
// The Developer Mode app's "Extend" button resets that clock; this service
// does the same thing on the app's behalf, so nobody has to remember to.
// It reads the session token the TV keeps for Developer Mode and asks LG's
// developer site to reset the session, exactly as the button does. The
// token never leaves this service except in that request.
//
// On a TV where the app was installed from the store there is no Developer
// Mode session, and every call here simply reports that.
var Service = require('webos-service');
var fs = require('fs');
var https = require('https');

var service = new Service('com.freesaver.app.service');
var TOKEN_FILE = '/var/luna/preferences/devmode_enabled';
var HOST = 'developer.lge.com';

function readToken() {
  try {
    var token = String(fs.readFileSync(TOKEN_FILE)).trim();
    return /^[A-Za-z0-9._-]{16,}$/.test(token) ? token : null;
  } catch (e) {
    return null;
  }
}

function ask(action, token, done) {
  var finished = false;
  var finish = function (err, body) { if (!finished) { finished = true; done(err, body); } };
  var req = https.get({
    host: HOST,
    path: '/secure/' + action + 'DevModeSession.dev?sessionToken=' + encodeURIComponent(token),
    headers: { 'User-Agent': 'freeSaver' }
  }, function (res) {
    var text = '';
    res.on('data', function (d) { text += d; });
    res.on('end', function () {
      try { finish(null, JSON.parse(text)); } catch (e) { finish(new Error('unexpected reply from LG (' + res.statusCode + ')')); }
    });
  });
  req.setTimeout(15000, function () { req.abort(); finish(new Error('timed out')); });
  req.on('error', function (e) { finish(e); });
}

// "999:46:25" -> hours as a number
function hours(text) {
  var m = /^(\d+):(\d+):(\d+)$/.exec(String(text || ''));
  return m ? Math.round((Number(m[1]) + Number(m[2]) / 60) * 10) / 10 : null;
}

// devmode {extend: true|false} -> {devMode, hoursLeft, extended}
service.register('devmode', function (message) {
  var token = readToken();
  if (!token) {
    message.respond({ returnValue: true, devMode: false });
    return;
  }
  var wantExtend = !!(message.payload && message.payload.extend);
  var check = function (extended) {
    ask('Check', token, function (err, body) {
      if (err || !body || body.result !== 'success') {
        message.respond({ returnValue: false, devMode: true, extended: extended, errorText: err ? err.message : 'LG refused the session check' });
        return;
      }
      message.respond({ returnValue: true, devMode: true, extended: extended, hoursLeft: hours(body.errorMsg) });
    });
  };
  if (!wantExtend) { check(false); return; }
  ask('Reset', token, function (err, body) {
    check(!err && !!body && body.result === 'success');
  });
});
