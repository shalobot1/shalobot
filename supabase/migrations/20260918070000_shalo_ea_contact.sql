-- Headway: a request is matched by the NAME and EMAIL registered there, not by
-- an MT5 ID, and the community is guided afterwards on a phone number — on
-- WhatsApp or Telegram, whichever the person chose. `mt5_login` stays (older
-- rows have one; newer rows carry the phone there too, so nothing that reads
-- the column changes shape).
alter table public.shalo_ea_requests
  add column if not exists phone   text,
  add column if not exists contact text check (contact in ('whatsapp', 'telegram')),
  add column if not exists country text;

-- The automatic re-approval looks up an approved row by email + phone.
create index if not exists shalo_ea_requests_email_phone
  on public.shalo_ea_requests (lower(email), phone);
