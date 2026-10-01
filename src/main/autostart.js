'use strict';

// Launch at login, on each platform's own terms. Windows and macOS have a
// login-item API; Linux uses an XDG autostart .desktop file.

const fs = require('fs');
const path = require('path');

const HIDDEN_FLAG = '--hidden';

function linuxDesktopFile(appData) {
  return path.join(appData, 'autostart', 'honeybee.desktop');
}

function linuxExec() {
  // An AppImage runs from a temporary mount; APPIMAGE is the file to relaunch.
  return process.env.APPIMAGE || process.execPath;
}

// The Windows portable build runs from a temporary folder that is deleted
// when it quits; the file to start at login is the portable .exe itself.
function windowsExe() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function setLaunchAtLogin(app, enabled) {
  if (process.platform === 'linux') {
    const file = linuxDesktopFile(app.getPath('appData'));
    if (!enabled) {
      try { fs.unlinkSync(file); } catch (_) { /* not there */ }
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=honeybee',
      'Comment=Watch your coding agents and your usage limits',
      `Exec="${linuxExec()}" ${HIDDEN_FLAG}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      ''
    ].join('\n'));
    return;
  }
  if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), path: windowsExe(), args: [HIDDEN_FLAG] });
    return;
  }
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: [HIDDEN_FLAG] });
}

function isLaunchAtLogin(app) {
  if (process.platform === 'linux') return fs.existsSync(linuxDesktopFile(app.getPath('appData')));
  try {
    const query = process.platform === 'win32' ? { path: windowsExe(), args: [HIDDEN_FLAG] } : { args: [HIDDEN_FLAG] };
    return Boolean(app.getLoginItemSettings(query).openAtLogin);
  } catch (_) {
    return false;
  }
}

// Was this launch the login item, rather than the user opening the app?
function startedAtLogin(app, argv) {
  if (argv.includes(HIDDEN_FLAG)) return true;
  if (process.platform === 'darwin') {
    try { return Boolean(app.getLoginItemSettings().wasOpenedAtLogin); } catch (_) { return false; }
  }
  return false;
}

module.exports = { setLaunchAtLogin, isLaunchAtLogin, startedAtLogin, HIDDEN_FLAG };
