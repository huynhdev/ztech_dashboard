-- ============================================================
-- Migration: get_dashboard_overview() — include labs with no cases in heatmapLabs
-- Purpose: The client heatmap previously only listed labs that had at least one
--          case in the selected range, so inactive clients were invisible.
--          heatmapLabs now starts from public.labs: labs with no cases in range
--          are appended with empty cells/amounts/redos and zero totals, letting
--          the UI surface "no case" labs. Cases with a null lab_id keep their
--          aggregated "Lab #null" row. Otherwise identical to
--          20260611100007_heatmap_daily_redos.sql.
-- ============================================================

create or replace function public.get_dashboard_overview(p_from date, p_to date)
returns jsonb
language sql
stable
set search_path = ''
as $$
with filtered as (
  select
    c.order_date,
    c.amount,
    c.status,
    c.lab_id,
    c.doctor_id,
    c.patient_id,
    c.is_redo,
    coalesce(nullif(l.name, ''), 'Lab #' || coalesce(c.lab_id::text, 'null')) as lab_name,
    coalesce(nullif(d.name, ''), 'Doctor #' || coalesce(c.doctor_id::text, 'null')) as doctor_name,
    coalesce(nullif(p.category, ''), 'Unknown') as category
  from public.incoming_cases c
  left join public.labs l on l.id = c.lab_id
  left join public.doctors d on d.id = c.doctor_id
  left join public.products p on p.id = c.product_id
  where c.order_date between p_from and p_to
),
series as (
  select
    g.granularity,
    case g.granularity
      when 'daily' then c.order_date::text
      when 'weekly' then to_char(date_trunc('week', c.order_date), 'YYYY-MM-DD')
      else to_char(c.order_date, 'YYYY-MM')
    end as period,
    round(sum(c.amount), 2) as revenue,
    count(*) as cases,
    count(distinct coalesce(c.lab_id, -1)) as unique_labs,
    count(distinct coalesce(c.doctor_id, -1)) as unique_doctors,
    count(distinct coalesce(c.patient_id, -1)) as unique_patients,
    count(*) filter (where c.status = 'Shipped') as shipped,
    count(*) filter (where c.status = 'In Production') as in_production,
    count(*) filter (
      where c.status is distinct from 'Shipped'
        and c.status is distinct from 'In Production'
    ) as hold,
    count(*) filter (where c.is_redo) as redo
  from filtered c
  cross join (values ('daily'), ('weekly'), ('monthly')) as g(granularity)
  group by 1, 2
),
lab_agg as (
  select lab_id, lab_name,
         jsonb_object_agg(day, cnt) as cells,
         jsonb_object_agg(day, round(amt, 2)) as amounts,
         coalesce(
           jsonb_object_agg(day, redo_cnt) filter (where redo_cnt > 0),
           '{}'::jsonb
         ) as redos,
         round(sum(amt), 2) as total_amount,
         sum(redo_cnt) as total_redo
  from (
    select lab_id, lab_name, order_date::text as day,
           count(*) as cnt, sum(amount) as amt,
           count(*) filter (where is_redo) as redo_cnt
    from filtered
    group by lab_id, lab_name, order_date
  ) c
  group by lab_id, lab_name
)
select jsonb_build_object(
  'summary', (
    select jsonb_build_object(
      'totalRevenue', coalesce(round(sum(amount), 2), 0),
      'totalCases', count(*),
      'uniqueLabCount', count(distinct coalesce(lab_id, -1)),
      'uniqueDoctorCount', count(distinct coalesce(doctor_id, -1)),
      'uniquePatientCount', count(distinct coalesce(patient_id, -1)),
      'shipped', count(*) filter (where status = 'Shipped'),
      'inProduction', count(*) filter (where status = 'In Production'),
      'hold', count(*) filter (where status = 'Hold'),
      'redo', count(*) filter (where is_redo)
    )
    from filtered
  ),
  'series', jsonb_build_object(
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object(
        'period', period, 'revenue', revenue, 'cases', cases,
        'uniqueLabs', unique_labs, 'uniqueDoctors', unique_doctors,
        'uniquePatients', unique_patients, 'shipped', shipped,
        'inProduction', in_production, 'hold', hold, 'redo', redo
      ) order by period)
      from series where granularity = 'daily'
    ), '[]'::jsonb),
    'weekly', coalesce((
      select jsonb_agg(jsonb_build_object(
        'period', period, 'revenue', revenue, 'cases', cases,
        'uniqueLabs', unique_labs, 'uniqueDoctors', unique_doctors,
        'uniquePatients', unique_patients, 'shipped', shipped,
        'inProduction', in_production, 'hold', hold, 'redo', redo
      ) order by period)
      from series where granularity = 'weekly'
    ), '[]'::jsonb),
    'monthly', coalesce((
      select jsonb_agg(jsonb_build_object(
        'period', period, 'revenue', revenue, 'cases', cases,
        'uniqueLabs', unique_labs, 'uniqueDoctors', unique_doctors,
        'uniquePatients', unique_patients, 'shipped', shipped,
        'inProduction', in_production, 'hold', hold, 'redo', redo
      ) order by period)
      from series where granularity = 'monthly'
    ), '[]'::jsonb)
  ),
  'categories', coalesce((
    select jsonb_agg(jsonb_build_object(
      'category', category, 'count', cnt, 'revenue', revenue
    ) order by cnt desc)
    from (
      select category, count(*) as cnt, round(sum(amount), 2) as revenue
      from filtered
      group by category
    ) t
  ), '[]'::jsonb),
  'topLabs', coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', lab_name, 'count', cnt, 'revenue', revenue
    ) order by cnt desc)
    from (
      select lab_id, lab_name, count(*) as cnt, round(sum(amount), 2) as revenue
      from filtered
      group by lab_id, lab_name
      order by count(*) desc
      limit 10
    ) t
  ), '[]'::jsonb),
  'topDoctors', coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', doctor_name, 'count', cnt, 'revenue', revenue
    ) order by cnt desc)
    from (
      select doctor_id, doctor_name, count(*) as cnt, round(sum(amount), 2) as revenue
      from filtered
      group by doctor_id, doctor_name
      order by count(*) desc
      limit 10
    ) t
  ), '[]'::jsonb),
  'heatmapLabs', coalesce((
    select jsonb_agg(jsonb_build_object(
      'labId', t.lab_id, 'labName', t.lab_name, 'cells', t.cells,
      'amounts', t.amounts, 'redos', t.redos,
      'totalAmount', t.total_amount, 'totalRedo', t.total_redo
    ))
    from (
      select lab_id, lab_name, cells, amounts, redos, total_amount, total_redo
      from lab_agg
      union all
      select l.id,
             coalesce(nullif(l.name, ''), 'Lab #' || l.id::text),
             '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
             0::numeric, 0::bigint
      from public.labs l
      where not exists (select 1 from lab_agg a where a.lab_id = l.id)
    ) t
  ), '[]'::jsonb)
)
$$;

comment on function public.get_dashboard_overview(date, date) is
  'All aggregates for the dashboard overview page in one round trip (heatmapLabs includes every lab — labs with no cases in range have empty cells); security invoker, so RLS on incoming_cases/labs applies to the caller.';

revoke execute on function public.get_dashboard_overview(date, date) from public, anon;
grant execute on function public.get_dashboard_overview(date, date) to authenticated, service_role;
