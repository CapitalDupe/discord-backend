'use strict';

// WebSocket events about your own profile. Result contract: see handlers/message.js.

const { query } = require('../../db/pool');
const { clip } = require('../../lib/util');
const { sendToUser, updateProfile } = require('../connections');

const MAX_NAME_LENGTH = 32;

module.exports = {
  // Change your display name and/or colour (colour must look like #rrggbb).
  'user.set': async (user, e) => {
    const input = e.u || {};
    const name = clip(input.name, MAX_NAME_LENGTH).trim();
    const color = /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : user.color;
    const displayName = name || user.display_name;

    await query('update users set display_name=$1,color=$2 where id=$3', [displayName, color, user.id]);
    updateProfile(user.id, displayName, color);
    sendToUser(user.id, { t: 'user.set', u: { id: user.id, name: displayName, color } });
    return 'ok';
  },
};
