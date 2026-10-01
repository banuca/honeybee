'use strict';

// Where the two agents keep their files. Both honour the same override
// variables the agents themselves read, so a user who moved Claude Code's or
// Codex's home is followed there.

const os = require('os');
const path = require('path');

function homeOf(env = process.env) {
  return env.HONEYBEE_HOME || os.homedir();
}

function claudeDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(homeOf(env), '.claude');
}

function codexDir(env = process.env) {
  return env.CODEX_HOME || path.join(homeOf(env), '.codex');
}

module.exports = {
  homeOf,
  claudeDir,
  claudeSettingsPath: (env) => path.join(claudeDir(env), 'settings.json'),
  claudeProjectsDir: (env) => path.join(claudeDir(env), 'projects'),
  codexDir,
  codexHooksPath: (env) => path.join(codexDir(env), 'hooks.json'),
  codexSessionsDir: (env) => path.join(codexDir(env), 'sessions')
};
