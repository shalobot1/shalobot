-- SHALOBOT — support threads, the door, and EA access. Applied once.
-- RLS is ON with NO policies on every table: nothing here is reachable from a
-- browser. The only doors are the functions under /api, which hold the service key.

create table if not exists public.shalo_support_messages (
  id              uuid primary key default gen_random_uuid(),
  visitor_id      text not null,

  -- 'in'  = from the visitor, posted to Telegram
  -- 'out' = the owner's reply, waiting for the visitor to collect it
  direction       text not null check (direction in ('in', 'out')),
  body            text not null,

  -- Carried on inbound messages so a reply has context without a second lookup.
  email           text,
  name            text,
  source          text,
  page            text,

  -- The Telegram message this became. Only inbound rows have one.
  tg_message_id   bigint,

  -- A picture or a document, either direction. The file lives in the
  -- `support-files` storage bucket; these are the pointer, label and type.
  attachment_url  text,
  attachment_name text,
  attachment_type text,

  -- When the visitor's browser collected an outbound reply. Null = waiting.
  seen_at         timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists shalo_support_messages_visitor_idx
  on public.shalo_support_messages (visitor_id, created_at desc);

create unique index if not exists shalo_support_messages_tg_idx
  on public.shalo_support_messages (tg_message_id)
  where tg_message_id is not null;

create index if not exists shalo_support_messages_unseen_idx
  on public.shalo_support_messages (created_at)
  where direction = 'out' and seen_at is null;

alter table public.shalo_support_messages enable row level security;

-- THE DOOR. A ban matches on EITHER the browser id or the email. Unbanning
-- does not delete the row: `active` goes false and `unbanned_at` is stamped.
create table if not exists public.shalo_support_bans (
  id           uuid primary key default gen_random_uuid(),
  visitor_id   text,
  email        text,
  name         text,
  reason       text,
  active       boolean not null default true,
  banned_at    timestamptz not null default now(),
  unbanned_at  timestamptz,
  constraint shalo_support_bans_has_key check (visitor_id is not null or email is not null)
);

create index if not exists shalo_support_bans_visitor_idx
  on public.shalo_support_bans (visitor_id) where active and visitor_id is not null;
create index if not exists shalo_support_bans_email_idx
  on public.shalo_support_bans (lower(email)) where active and email is not null;

alter table public.shalo_support_bans enable row level security;

-- Attachments are served from a public bucket under random names.
insert into storage.buckets (id, name, public)
  values ('support-files', 'support-files', true)
  on conflict (id) do nothing;

create unique index if not exists shalo_support_messages_tg_file_idx
  on public.shalo_support_messages (tg_file_message_id)
  where tg_file_message_id is not null;

create table if not exists public.shalo_ea_requests (
  id            uuid primary key default gen_random_uuid(),
  visitor_id    text not null,
  mt5_login     text not null,
  name          text not null,
  email         text not null,

  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'declined')),

  -- Minted on approval. Unique, so a code identifies exactly one request and
  -- therefore exactly one person.
  code          text unique,
  code_used_at  timestamptz,

  -- The Telegram message this request became. A swipe-reply points back at it.
  tg_message_id bigint,

  page          text,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  answered_at   timestamptz
);

create unique index if not exists shalo_ea_requests_code_idx
  on public.shalo_ea_requests (code) where code is not null;

create unique index if not exists shalo_ea_requests_tg_idx
  on public.shalo_ea_requests (tg_message_id) where tg_message_id is not null;

create index if not exists shalo_ea_requests_visitor_idx
  on public.shalo_ea_requests (visitor_id, created_at desc);

create index if not exists shalo_ea_requests_open_idx
  on public.shalo_ea_requests (created_at desc)
  where status = 'pending' and answered_at is null;

alter table public.shalo_ea_requests enable row level security;

