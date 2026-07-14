pragma foreign_keys = on;

create table if not exists users (
  discord_id text primary key,
  display_name text not null check (length(display_name) between 1 and 80),
  avatar_url text,
  is_admin integer not null default 0 check (is_admin in (0, 1)),
  created_at text not null,
  updated_at text not null
);

create table if not exists pins (
  id text primary key,
  x integer not null check (x between 0 and 14999),
  y integer not null check (y between 0 and 10999),
  kind text not null check (kind in ('plan', 'working', 'report', 'question')),
  status text not null check (status in ('open', 'in_progress', 'review', 'done', 'on_hold')),
  title text not null check (length(title) between 1 and 80),
  body text not null default '' check (length(body) <= 2000),
  related_url text check (related_url is null or length(related_url) <= 500),
  author_id text not null references users(discord_id) on delete restrict,
  created_at text not null,
  updated_at text not null,
  deleted_at text
);

create table if not exists comments (
  id text primary key,
  pin_id text not null references pins(id) on delete cascade,
  body text not null check (length(body) between 1 and 1000),
  author_id text not null references users(discord_id) on delete restrict,
  created_at text not null,
  updated_at text not null,
  deleted_at text
);

create index if not exists pins_visible_idx
  on pins (deleted_at, status, kind, updated_at desc);
create index if not exists comments_pin_idx
  on comments (pin_id, deleted_at, created_at);

