-- Applied on every start (see src/index.js), so every statement must be idempotent.

create table if not exists users (
  id            text primary key,
  username      text not null,
  display_name  text not null,
  color         text not null default '#5865f2',
  pass_hash     text not null,
  created_at    timestamptz not null default now()
);
create unique index if not exists users_username_lower on users (lower(username));

create table if not exists sessions (
  id          text primary key,
  user_id     text not null references users on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  user_agent  text
);
create index if not exists sessions_user on sessions (user_id);

create table if not exists servers (
  id          text primary key,
  name        text not null,
  owner_id    text not null references users on delete cascade,
  created_at  timestamptz not null default now()
);

create table if not exists roles (
  id          text primary key,
  server_id   text not null references servers on delete cascade,
  name        text not null,
  perms       int not null,
  position    int not null,
  is_default  boolean not null default false
);
create unique index if not exists roles_one_default on roles (server_id) where is_default;

create table if not exists members (
  server_id   text references servers on delete cascade,
  user_id     text references users on delete cascade,
  joined_at   timestamptz not null default now(),
  primary key (server_id, user_id)
);
create index if not exists members_user on members (user_id);

create table if not exists member_roles (
  server_id   text not null,
  user_id     text not null,
  role_id     text not null references roles on delete cascade,
  primary key (server_id, user_id, role_id),
  foreign key (server_id, user_id) references members on delete cascade
);

create table if not exists channels (
  id          text primary key,
  server_id   text not null references servers on delete cascade,
  name        text not null,
  type        text not null check (type in ('text','voice')),
  pos         bigserial
);
create index if not exists channels_server on channels (server_id);

create table if not exists messages (
  id          text primary key,
  channel_id  text not null references channels on delete cascade,
  user_id     text references users on delete set null,
  text        text not null,
  edited      boolean not null default false,
  ts          timestamptz not null default now()
);
create index if not exists messages_chan_ts on messages (channel_id, ts desc);

create table if not exists reactions (
  message_id  text references messages on delete cascade,
  user_id     text references users on delete cascade,
  emoji       text not null,
  primary key (message_id, user_id, emoji)
);

create table if not exists invites (
  code        text primary key,
  server_id   text not null references servers on delete cascade,
  created_by  text references users on delete set null,
  expires_at  timestamptz,
  max_uses    int,
  uses        int not null default 0
);

-- Added after the first release, so it is an ALTER rather than part of CREATE TABLE.
alter table users add column if not exists is_official boolean not null default false;

-- Phase 2: avatars, replies, attachments, direct messages, friends, uploads.
alter table users add column if not exists avatar text;

-- Direct messages are channels with no server and type 'dm'.
alter table channels alter column server_id drop not null;
alter table channels drop constraint if exists channels_type_check;
alter table channels add constraint channels_type_check check (type in ('text','voice','dm'));

alter table messages add column if not exists reply_to text references messages(id) on delete set null;
alter table messages add column if not exists att jsonb;

create table if not exists dm_members (
  channel_id  text not null references channels on delete cascade,
  user_id     text not null references users on delete cascade,
  primary key (channel_id, user_id)
);
create index if not exists dm_members_user on dm_members (user_id);

-- One row per friendship: a = who asked, b = who was asked.
create table if not exists friends (
  a           text not null references users on delete cascade,
  b           text not null references users on delete cascade,
  status      text not null check (status in ('pending','accepted')),
  created_at  timestamptz not null default now(),
  primary key (a, b)
);
create index if not exists friends_b on friends (b);

create table if not exists uploads (
  id          text primary key,
  user_id     text not null references users on delete cascade,
  name        text not null,
  mime        text not null,
  size        int not null,
  created_at  timestamptz not null default now()
);
create index if not exists uploads_user on uploads (user_id);
