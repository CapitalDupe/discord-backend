'use strict';

// WebSocket events about your own profile. Result contract: see handlers/message.js.

const { query, queryOne } = require('../../db/pool');
const { clip, isId } = require('../../lib/util');
const { sendToAudience, updateProfile } = require('../connections');

const MAX_NAME_LENGTH = 32;

module.exports = {
  // Change your display name, colour (#rrggbb) and/or avatar (the id of an image you uploaded, or null to remove it).
  'user.set': async (user, e) => {
    const input = e.u || {};
    const name = clip(input.name, MAX_NAME_LENGTH).trim();
    const color = /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : user.color;
    const displayName = name || user.display_name;

    let avatar = user.avatar || null;
    if (input.avatar === null) {
      avatar = null;
    } else if (isId(input.avatar)) {
      const file = await queryOne('select mime from uploads where id=$1 and user_id=$2', [input.avatar, user.id]);
      if (file && file.mime.startsWith('image/')) avatar = input.avatar;
    }

    await query('update users set display_name=$1,color=$2,avatar=$3 where id=$4', [displayName, color, avatar, user.id]);
    updateProfile(user.id, displayName, color, avatar);
    // Everyone who can see you (shared servers, friends, DMs) and your other devices.
    await sendToAudience(user.id, { t: 'user.set', u: { id: user.id, name: displayName, color, avatar } }, true);
    return 'ok';
  },
};
