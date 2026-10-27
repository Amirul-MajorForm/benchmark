-- Idempotent: safe to run on every deploy (npm run migrate).

-- Editable mapping. Seeded from db/seed-accounts.sql.
create table if not exists accounts (
  platform     text not null,          -- 'meta'
  account_id   text not null,          -- without act_ prefix
  name         text,
  client       text not null,
  market       text not null,          -- SG, MY, ID, PH, TH, VN, JP, KR, TW, HK
  account_type text not null check (account_type in ('Brand', 'CPAS')),
  currency     text,
  enabled      boolean default true,
  primary key (platform, account_id)
);

-- One row per account x objective x goal x month. All money in SGD unless suffixed _native.
create table if not exists fact_monthly (
  platform        text not null,
  account_id      text not null,
  objective       text not null,       -- raw, e.g. OUTCOME_AWARENESS
  goal            text not null,       -- raw, e.g. REACH, 'Unknown Optimization Goal'
  month           date not null,       -- first of month
  spend_sgd       numeric not null default 0,
  impressions     bigint  not null default 0,
  clicks          bigint  not null default 0,
  link_clicks     bigint  not null default 0,
  spend_native    numeric,             -- query 3b (Sales only), account currency
  purchases       numeric,             -- collab_* for CPAS, all_purchases for Brand
  purchase_value_native numeric,
  purchase_value_sgd    numeric,       -- purchase_value_native x monthly spend rate
  synced_at       timestamptz default now(),
  primary key (platform, account_id, objective, goal, month)
);

create table if not exists sync_runs (
  id          serial primary key,
  started_at  timestamptz,
  finished_at timestamptz,
  status      text,                    -- running | success | failed
  rows        int,
  error       text
);

-- Half-year chunks that have been pulled at least once (closed chunks are frozen after that).
create table if not exists sync_chunks (
  platform    text not null,
  chunk_start date not null,
  chunk_end   date not null,
  synced_at   timestamptz not null default now(),
  primary key (platform, chunk_start)
);

-- Small key/value store, e.g. the Two Minutes Run query path found by the sync.
create table if not exists app_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- Daily exchange rates used to convert spend to SGD (the Two Minutes REST API returns local currency).
create table if not exists fx_daily (
  date         date not null,
  currency     text not null,            -- ISO code, upper case
  sgd_per_unit numeric not null,         -- SGD for 1 unit of currency
  fetched_at   timestamptz not null default now(),
  primary key (date, currency)
);

-- Leads (Meta "Leads (all)") for CPL. Added after launch, hence the alter.
alter table fact_monthly add column if not exists leads numeric;

-- App installs (Meta "App Installs (all)") for CPI.
alter table fact_monthly add column if not exists installs numeric;
