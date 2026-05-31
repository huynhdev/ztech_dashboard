-- ============================================================
-- Seed: initial admin user
-- Runs only on `supabase db reset` (yarn db:reset), not on migrate/push.
--
-- Email:    admin@ztechdental.com
-- Password: K9m$Rv2pZx!Lq7Wf
--
-- Creates the auth user + identity directly (works on local and hosted),
-- then upserts the public.profiles row to role 'admin'. The
-- on_auth_user_created trigger pre-creates the profile as 'viewer';
-- the upsert below promotes it to 'admin'.
-- ============================================================

do $$
declare
  admin_email text := 'admin@ztechdental.com';
  admin_password text := 'K9m$Rv2pZx!Lq7Wf';
  existing_user_id uuid;
  new_user_id uuid;
begin
  select id into existing_user_id from auth.users where email = admin_email;

  if existing_user_id is not null then
    insert into public.profiles (id, email, full_name, role)
    values (existing_user_id, admin_email, 'Administrator', 'admin')
    on conflict (id) do update
      set role = 'admin', full_name = excluded.full_name;
    raise notice 'Admin user already exists: %', existing_user_id;
  else
    new_user_id := gen_random_uuid();

    insert into auth.users (
      id,
      instance_id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      created_at,
      updated_at,
      raw_app_meta_data,
      raw_user_meta_data,
      is_sso_user,
      is_anonymous,
      phone,
      confirmation_token,
      recovery_token,
      email_change_token_new,
      email_change,
      email_change_token_current,
      email_change_confirm_status,
      reauthentication_token
    ) values (
      new_user_id,
      '00000000-0000-0000-0000-000000000000',
      'authenticated',
      'authenticated',
      admin_email,
      extensions.crypt(admin_password, extensions.gen_salt('bf', 10)),
      now(),
      now(),
      now(),
      '{"provider": "email", "providers": ["email"]}',
      '{"email_verified": true, "full_name": "Administrator"}',
      false,
      false,
      '',
      '',
      '',
      '',
      '',
      '',
      0,
      ''
    );

    insert into auth.identities (
      id,
      user_id,
      provider_id,
      identity_data,
      provider,
      last_sign_in_at,
      created_at,
      updated_at
    ) values (
      gen_random_uuid(),
      new_user_id,
      new_user_id::text,
      jsonb_build_object(
        'sub', new_user_id::text,
        'email', admin_email,
        'email_verified', true,
        'phone_verified', false
      ),
      'email',
      now(),
      now(),
      now()
    );

    -- the trigger already inserted a 'viewer' profile; promote to admin
    insert into public.profiles (id, email, full_name, role)
    values (new_user_id, admin_email, 'Administrator', 'admin')
    on conflict (id) do update
      set role = 'admin', full_name = excluded.full_name;

    raise notice 'Created admin user: %', new_user_id;
  end if;
end $$;
