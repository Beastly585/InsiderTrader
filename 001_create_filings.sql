-- ─────────────────────────────────────────────────────────────────────────────
-- supabase/migrations/001_create_filings.sql
--
-- Run this in the Supabase SQL editor (or via `supabase db push`).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.filings (
  id                bigint        generated always as identity primary key,
  accession_number  text          not null unique,   -- e.g. 0001234567-24-001234
  filing_date       date,
  company_name      text,
  ticker            text,
  insider_name      text,
  insider_title     text,
  transaction_type  text          check (transaction_type in ('buy','sell','other', null)),
  shares            numeric(20,4),
  price_per_share   numeric(16,4),
  security_title    text,
  relationship      text          check (relationship in ('strong','medium','weak', null)),
  sector            text,
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now()
);

-- ── Indexes for the filters the UI uses ──────────────────────────────────────
create index if not exists idx_filings_date         on public.filings (filing_date desc);
create index if not exists idx_filings_ticker        on public.filings (ticker);
create index if not exists idx_filings_type          on public.filings (transaction_type);
create index if not exists idx_filings_relationship  on public.filings (relationship);
create index if not exists idx_filings_sector        on public.filings (sector);

-- Full-text search index (enables fast ILIKE-style search on company + insider)
create index if not exists idx_filings_fts on public.filings
  using gin (to_tsvector('english', coalesce(company_name,'') || ' ' || coalesce(insider_name,'')));

-- ── Auto-update updated_at ────────────────────────────────────────────────────
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_filings_updated_at on public.filings;
create trigger trg_filings_updated_at
  before update on public.filings
  for each row execute function update_updated_at();

-- ── Row-level security: read-only for the anon/public role ───────────────────
alter table public.filings enable row level security;

create policy "Anyone can read filings"
  on public.filings
  for select
  to anon, authenticated
  using (true);

-- Only the service role (your Python script) can write
-- (no insert/update policy for anon — service role bypasses RLS by default)

-- ── Optional: view for the last 30 days (handy for quick queries) ─────────────
create or replace view public.recent_filings as
  select * from public.filings
  where filing_date >= current_date - interval '30 days'
  order by filing_date desc;
