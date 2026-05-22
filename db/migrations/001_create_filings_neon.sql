-- ─────────────────────────────────────────────────────────────────────────────
-- db/migrations/001_create_filings.sql
--
-- Run this in the Neon Console SQL Editor (or paste into psql).
-- All statements are idempotent — safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Main filings table ────────────────────────────────────────────────────────

create table if not exists public.filings (

  -- Primary key
  id                      bigint        generated always as identity primary key,

  -- Filing identifiers
  -- One Form 4 can contain multiple transactions → multiple rows per accession
  accession_number        text          not null,
  cik                     text,

  -- Issuer (the company whose stock was traded)
  company_name            text,
  ticker                  text,
  cik_issuer              text,

  -- Reporting owner (the insider doing the trading)
  insider_name            text,
  insider_cik             text,
  insider_title           text,
  is_director             boolean       not null default false,
  is_officer              boolean       not null default false,
  is_ten_pct_owner        boolean       not null default false,

  -- Transaction detail
  filing_date             date,                     -- period_of_report from XML
  transaction_date        date,                     -- actual transaction date
  transaction_type        text          check (transaction_type in ('buy','sell','other')),
  transaction_code        text,                     -- raw EDGAR code: P, S, A, M, F…
  transaction_code_label  text,                     -- "Open Market Purchase", "Grant / Award", …
  is_derivative           boolean       not null default false,

  -- Security
  security_title          text,                     -- "Common Stock", "Stock Option (Right to Buy)", …
  shares                  numeric(20,4),
  price_per_share         numeric(16,4),
  value                   numeric(20,2),            -- computed: shares * price

  -- Post-transaction holdings
  shares_owned_after      numeric(20,4),
  direct_ownership        boolean       not null default true,  -- D=direct, I=indirect

  -- Enriched fields (computed by Python)
  relationship            text          check (relationship in ('strong','medium','weak')),
  sector                  text,

  -- Raw footnote text from the filing
  footnotes               text,

  -- Audit timestamps
  created_at              timestamptz   not null default now(),
  updated_at              timestamptz   not null default now(),

  -- Composite unique: one row per distinct transaction within a filing
  unique (accession_number, transaction_date, shares, transaction_code)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

create index if not exists idx_filings_filing_date      on public.filings (filing_date desc);
create index if not exists idx_filings_transaction_date on public.filings (transaction_date desc);
create index if not exists idx_filings_ticker           on public.filings (ticker);
create index if not exists idx_filings_type             on public.filings (transaction_type);
create index if not exists idx_filings_relationship     on public.filings (relationship);
create index if not exists idx_filings_sector           on public.filings (sector);
create index if not exists idx_filings_code             on public.filings (transaction_code);
create index if not exists idx_filings_value            on public.filings (value desc nulls last);
create index if not exists idx_filings_is_derivative    on public.filings (is_derivative);

-- Full-text search index across company + insider + ticker
create index if not exists idx_filings_fts on public.filings
  using gin (
    to_tsvector(
      'english',
      coalesce(company_name, '') || ' ' ||
      coalesce(insider_name, '')  || ' ' ||
      coalesce(ticker, '')
    )
  );

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

-- ── Useful views ──────────────────────────────────────────────────────────────

-- Last 30 days, open-market buys and sells only
create or replace view public.recent_trades as
  select *
  from   public.filings
  where  filing_date >= current_date - interval '30 days'
    and  transaction_type in ('buy', 'sell')
  order  by filing_date desc, value desc nulls last;

-- Top open-market purchases by value, last 90 days
create or replace view public.top_buys_90d as
  select
    ticker,
    company_name,
    insider_name,
    insider_title,
    sum(value)       as total_value,
    sum(shares)      as total_shares,
    count(*)         as transaction_count,
    max(filing_date) as latest_date
  from  public.filings
  where transaction_type = 'buy'
    and transaction_code = 'P'
    and filing_date >= current_date - interval '90 days'
    and value is not null
  group by ticker, company_name, insider_name, insider_title
  order by total_value desc nulls last;

-- Sector buy/sell summary, last 30 days
create or replace view public.sector_summary as
  select
    sector,
    count(*) filter (where transaction_type = 'buy')  as buy_count,
    count(*) filter (where transaction_type = 'sell') as sell_count,
    sum(value) filter (where transaction_type = 'buy')  as buy_value,
    sum(value) filter (where transaction_type = 'sell') as sell_value
  from  public.filings
  where filing_date >= current_date - interval '30 days'
  group by sector
  order by buy_count desc;
