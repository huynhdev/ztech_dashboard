-- ============================================================
-- Migration: Create profiles table with role-based access
-- Purpose: Extend auth.users with an app role (admin/operator/viewer)
--          used to gate access to the dashboard.
-- Affected: public.user_role enum, public.profiles table,
--           public.is_admin() helper, public.handle_new_user() trigger
-- Special considerations: Enables RLS; admin reads/writes are gated
--          via a SECURITY DEFINER helper to avoid policy recursion.
-- ============================================================

-- app-level role, mirrors the User type in lib/data.ts
create type public.user_role as enum ('admin', 'operator', 'viewer');

-- one profile row per auth user
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  role public.user_role not null default 'viewer',
  status text not null default 'active',
  created_at timestamptz not null default now()
);

comment on table public.profiles is 'Per-user app profile and role, keyed to auth.users.';
comment on column public.profiles.role is 'App role gating dashboard access; admin is required to sign in.';

create index profiles_role_idx on public.profiles (role);

-- returns true when the calling user is an admin.
-- SECURITY DEFINER so it bypasses RLS on profiles and cannot recurse
-- through the policies that call it.
create function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin'
  );
$$;

comment on function public.is_admin() is 'True when the current user has the admin role.';

-- auto-create a profile when a new auth user is created.
-- SECURITY DEFINER so the insert bypasses RLS.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- Data API grants (new tables are no longer auto-exposed; RLS still applies)
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.profiles to service_role;

-- enable row level security
alter table public.profiles enable row level security;

-- SELECT: a user can read their own profile; admins can read all
create policy "Users can read own profile or admins read all"
  on public.profiles
  for select
  to authenticated
  using ( (select auth.uid()) = id or public.is_admin() );

-- INSERT: only admins may add profiles (the signup trigger bypasses RLS)
create policy "Admins can insert profiles"
  on public.profiles
  for insert
  to authenticated
  with check ( public.is_admin() );

-- UPDATE: only admins may change profiles
create policy "Admins can update profiles"
  on public.profiles
  for update
  to authenticated
  using ( public.is_admin() )
  with check ( public.is_admin() );

-- DELETE: only admins may remove profiles
create policy "Admins can delete profiles"
  on public.profiles
  for delete
  to authenticated
  using ( public.is_admin() );
